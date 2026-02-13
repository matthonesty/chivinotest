import "./styles.css";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { PointerLockControls } from "three/examples/jsm/controls/PointerLockControls.js";

const DEFAULT_COMPANY = "chivino";
const DEFAULT_SCENE = "oceanview01";
const DEFAULT_COUNTERTOP_TEXTURE = "69c999fc663f92c30e28ffc64b049656";
const SLABCLOUD_PROXY_PREFIX = "/slabcloud-proxy";
const SKY_DISTANCE_TO_SCENE = 100;
const MIN_SKY_RADIUS = 250;

const params = new URLSearchParams(window.location.search);
const company = params.get("company") || DEFAULT_COMPANY;
const sceneName = params.get("scene") || DEFAULT_SCENE;
const requestedCountertopTexture =
  params.get("counteroptexture") ||
  params.get("countertoptexture") ||
  params.get("countertop") ||
  DEFAULT_COUNTERTOP_TEXTURE;

const sceneBaseUrl = `${SLABCLOUD_PROXY_PREFIX}/3dv22/scenes/${sceneName}/`;

const dom = {
  canvas: document.getElementById("native-scene-canvas"),
  status: document.getElementById("viewer-status"),
  sceneMeta: document.getElementById("scene-meta"),
  cameraModeButton: document.getElementById("camera-mode-button"),
  resetCameraButton: document.getElementById("reset-camera-button"),
  fpsHint: document.getElementById("fps-hint"),
  textureSelect: document.getElementById("texture-select"),
  textureSelectPreview: document.getElementById("texture-select-preview"),
  applySelectionButton: document.getElementById("apply-selection-button"),
  countertopTargets: document.getElementById("countertop-targets"),
};

if (!dom.canvas || !dom.status) {
  throw new Error("Native viewer bootstrap failed: expected DOM nodes are missing.");
}

const renderer = new THREE.WebGLRenderer({
  canvas: dom.canvas,
  antialias: true,
  alpha: false,
  powerPreference: "high-performance",
});
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x090f16);
scene.up.set(0, 0, 1);
const baseBackgroundColor = scene.background.clone();

const camera = new THREE.PerspectiveCamera(56, 1, 0.05, 1800);
camera.position.set(15, -16, 6);
camera.up.set(0, 0, 1);

const orbitControls = new OrbitControls(camera, renderer.domElement);
orbitControls.enableDamping = true;
orbitControls.dampingFactor = 0.08;
orbitControls.target.set(0, 0, 1.2);
orbitControls.maxDistance = 240;
orbitControls.minDistance = 0.25;

const fpsControls = new PointerLockControls(camera, renderer.domElement);

const keyLight = new THREE.DirectionalLight(0xffffff, 1.0);
keyLight.position.set(20, -14, 26);
scene.add(keyLight);

const fillLight = new THREE.DirectionalLight(0x84a4c4, 0.4);
fillLight.position.set(-18, 9, 16);
scene.add(fillLight);

scene.add(new THREE.AmbientLight(0xfff0dc, 0.55));

const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(900, 900),
  new THREE.MeshStandardMaterial({
    color: 0x111922,
    roughness: 1,
    metalness: 0,
    transparent: true,
    opacity: 0.86,
  })
);
ground.position.z = -0.02;
ground.receiveShadow = false;
scene.add(ground);

const worldRoot = new THREE.Group();
scene.add(worldRoot);

const runtime = {
  sceneJson: null,
  configJson: null,
  exteriorMode: "none",
  cameraMode: "orbit",
  keyState: new Set(),
  bounds: new THREE.Box3(),
  defaultOrbitPosition: new THREE.Vector3(15, -16, 6),
  defaultOrbitTarget: new THREE.Vector3(0, 0, 1.2),
  defaultFpsPosition: new THREE.Vector3(0, -8, 1.6),
  materialByIndex: new Map(),
  meshesByMaterialIndex: new Map(),
  meshesByNodeId: new Map(),
  countertopMaterialIndexes: [],
  countertopNodeIds: [],
  countertopMaterials: [],
  countertopOverrideMaterials: new Map(),
  countertopMeshes: [],
  countertopNormalsHarmonized: false,
  skyMesh: null,
  skyEnvironmentMap: null,
  skyRadius: MIN_SKY_RADIUS,
  sceneTextureCache: new Map(),
  externalTextureCache: new Map(),
  textureCatalog: [],
  animId: 0,
};

const sceneTextureLoader = new THREE.TextureLoader();
sceneTextureLoader.setCrossOrigin("anonymous");

const externalTextureLoader = new THREE.TextureLoader();
externalTextureLoader.setCrossOrigin("anonymous");

const scratchVecA = new THREE.Vector3();
const scratchVecB = new THREE.Vector3();

function setStatus(message, isError = false) {
  if (!dom.status) {
    return;
  }

  dom.status.textContent = message;
  dom.status.dataset.error = isError ? "true" : "false";
}

function refreshSceneMeta() {
  if (!dom.sceneMeta) {
    return;
  }

  const exteriorLabel = runtime.exteriorMode === "sky" ? "Sky" : "None";
  dom.sceneMeta.textContent = `Company: ${company}  |  Scene: ${sceneName}  |  Exterior: ${exteriorLabel}`;
}

function setCountertopTargets(names) {
  if (!dom.countertopTargets) {
    return;
  }

  if (!names.length) {
    dom.countertopTargets.textContent =
      "Countertop target materials were not detected in this scene config.";
    return;
  }

  dom.countertopTargets.textContent = `Targets: ${names.join(", ")}`;
}

function clamp01(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(Math.max(parsed, 0), 1);
}

function medianValue(values) {
  if (!values.length) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function estimateBackdropFromCorners(data, width, height) {
  const size = Math.max(8, Math.floor(Math.min(width, height) * 0.06));
  const step = Math.max(1, Math.floor(size / 10));
  const cornerOffsets = [
    [0, 0],
    [Math.max(0, width - size), 0],
    [0, Math.max(0, height - size)],
    [Math.max(0, width - size), Math.max(0, height - size)],
  ];

  const reds = [];
  const greens = [];
  const blues = [];

  cornerOffsets.forEach(([offsetX, offsetY]) => {
    const endX = Math.min(width, offsetX + size);
    const endY = Math.min(height, offsetY + size);
    for (let y = offsetY; y < endY; y += step) {
      for (let x = offsetX; x < endX; x += step) {
        const index = (y * width + x) * 4;
        reds.push(data[index]);
        greens.push(data[index + 1]);
        blues.push(data[index + 2]);
      }
    }
  });

  const red = medianValue(reds);
  const green = medianValue(greens);
  const blue = medianValue(blues);

  const distances = [];
  for (let i = 0; i < reds.length; i += 1) {
    const dr = reds[i] - red;
    const dg = greens[i] - green;
    const db = blues[i] - blue;
    distances.push(Math.sqrt(dr * dr + dg * dg + db * db));
  }
  distances.sort((a, b) => a - b);
  const p85Index = Math.min(distances.length - 1, Math.floor(distances.length * 0.85));
  const p85 = distances[p85Index] || 0;
  const threshold = Math.max(20, Math.min(84, p85 + 18));

  return { red, green, blue, threshold };
}

function cropAndFillCountertopTextureImage(image) {
  const width =
    image?.naturalWidth || image?.videoWidth || image?.width || image?.clientWidth || 0;
  const height =
    image?.naturalHeight || image?.videoHeight || image?.height || image?.clientHeight || 0;
  if (!width || !height) {
    return null;
  }

  const sourceCanvas = document.createElement("canvas");
  sourceCanvas.width = width;
  sourceCanvas.height = height;
  const sourceContext = sourceCanvas.getContext("2d", { willReadFrequently: true });
  if (!sourceContext) {
    return null;
  }
  sourceContext.drawImage(image, 0, 0, width, height);

  let sourceImage;
  try {
    sourceImage = sourceContext.getImageData(0, 0, width, height);
  } catch {
    return null;
  }

  const sourceData = sourceImage.data;
  const totalPixels = width * height;
  const backdrop = estimateBackdropFromCorners(sourceData, width, height);
  const thresholdSquared = backdrop.threshold * backdrop.threshold;
  const backgroundMask = new Uint8Array(totalPixels);
  const visited = new Uint8Array(totalPixels);
  const queue = new Uint32Array(totalPixels);
  let queueStart = 0;
  let queueEnd = 0;

  const enqueueIfBackground = (x, y) => {
    const index = y * width + x;
    if (visited[index]) {
      return;
    }
    visited[index] = 1;

    const offset = index * 4;
    const alpha = sourceData[offset + 3];
    if (alpha < 8) {
      backgroundMask[index] = 1;
      queue[queueEnd] = index;
      queueEnd += 1;
      return;
    }

    const dr = sourceData[offset] - backdrop.red;
    const dg = sourceData[offset + 1] - backdrop.green;
    const db = sourceData[offset + 2] - backdrop.blue;
    const distanceSquared = dr * dr + dg * dg + db * db;
    if (distanceSquared <= thresholdSquared) {
      backgroundMask[index] = 1;
      queue[queueEnd] = index;
      queueEnd += 1;
    }
  };

  for (let x = 0; x < width; x += 1) {
    enqueueIfBackground(x, 0);
    enqueueIfBackground(x, height - 1);
  }
  for (let y = 0; y < height; y += 1) {
    enqueueIfBackground(0, y);
    enqueueIfBackground(width - 1, y);
  }

  while (queueStart < queueEnd) {
    const index = queue[queueStart];
    queueStart += 1;
    const x = index % width;
    const y = Math.floor(index / width);

    if (x > 0) {
      enqueueIfBackground(x - 1, y);
    }
    if (x < width - 1) {
      enqueueIfBackground(x + 1, y);
    }
    if (y > 0) {
      enqueueIfBackground(x, y - 1);
    }
    if (y < height - 1) {
      enqueueIfBackground(x, y + 1);
    }
  }

  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  let foregroundCount = 0;

  for (let index = 0; index < totalPixels; index += 1) {
    if (backgroundMask[index]) {
      continue;
    }
    foregroundCount += 1;
    const x = index % width;
    const y = Math.floor(index / width);
    if (x < minX) {
      minX = x;
    }
    if (x > maxX) {
      maxX = x;
    }
    if (y < minY) {
      minY = y;
    }
    if (y > maxY) {
      maxY = y;
    }
  }

  if (foregroundCount === 0) {
    return null;
  }

  const foregroundRatio = foregroundCount / totalPixels;
  if (foregroundRatio < 0.04) {
    return null;
  }

  const padding = Math.max(2, Math.floor(Math.min(width, height) * 0.01));
  minX = Math.max(0, minX - padding);
  minY = Math.max(0, minY - padding);
  maxX = Math.min(width - 1, maxX + padding);
  maxY = Math.min(height - 1, maxY + padding);

  const cropWidth = maxX - minX + 1;
  const cropHeight = maxY - minY + 1;
  if (cropWidth < 8 || cropHeight < 8) {
    return null;
  }

  const colorCanvas = document.createElement("canvas");
  colorCanvas.width = cropWidth;
  colorCanvas.height = cropHeight;
  const colorContext = colorCanvas.getContext("2d", { willReadFrequently: true });
  if (!colorContext) {
    return null;
  }
  colorContext.drawImage(
    sourceCanvas,
    minX,
    minY,
    cropWidth,
    cropHeight,
    0,
    0,
    cropWidth,
    cropHeight
  );

  let colorImage;
  try {
    colorImage = colorContext.getImageData(0, 0, cropWidth, cropHeight);
  } catch {
    return colorCanvas;
  }

  const colorData = colorImage.data;
  const cropPixels = cropWidth * cropHeight;
  const cropBackgroundMask = new Uint8Array(cropPixels);
  let backgroundPixelsInCrop = 0;
  let avgR = 0;
  let avgG = 0;
  let avgB = 0;
  let avgCount = 0;

  for (let y = 0; y < cropHeight; y += 1) {
    for (let x = 0; x < cropWidth; x += 1) {
      const sourceIndex = (y + minY) * width + (x + minX);
      const cropIndex = y * cropWidth + x;
      if (backgroundMask[sourceIndex]) {
        cropBackgroundMask[cropIndex] = 1;
        backgroundPixelsInCrop += 1;
      } else {
        const offset = cropIndex * 4;
        avgR += colorData[offset];
        avgG += colorData[offset + 1];
        avgB += colorData[offset + 2];
        avgCount += 1;
      }
    }
  }

  if (!backgroundPixelsInCrop) {
    return colorCanvas;
  }

  const copyColor = (fromIndex, toIndex) => {
    const fromOffset = fromIndex * 4;
    const toOffset = toIndex * 4;
    colorData[toOffset] = colorData[fromOffset];
    colorData[toOffset + 1] = colorData[fromOffset + 1];
    colorData[toOffset + 2] = colorData[fromOffset + 2];
    colorData[toOffset + 3] = 255;
    cropBackgroundMask[toIndex] = 0;
  };

  for (let y = 0; y < cropHeight; y += 1) {
    let lastSolid = -1;
    for (let x = 0; x < cropWidth; x += 1) {
      const idx = y * cropWidth + x;
      if (!cropBackgroundMask[idx]) {
        lastSolid = idx;
      } else if (lastSolid >= 0) {
        copyColor(lastSolid, idx);
      }
    }
    lastSolid = -1;
    for (let x = cropWidth - 1; x >= 0; x -= 1) {
      const idx = y * cropWidth + x;
      if (!cropBackgroundMask[idx]) {
        lastSolid = idx;
      } else if (lastSolid >= 0) {
        copyColor(lastSolid, idx);
      }
    }
  }

  for (let x = 0; x < cropWidth; x += 1) {
    let lastSolid = -1;
    for (let y = 0; y < cropHeight; y += 1) {
      const idx = y * cropWidth + x;
      if (!cropBackgroundMask[idx]) {
        lastSolid = idx;
      } else if (lastSolid >= 0) {
        copyColor(lastSolid, idx);
      }
    }
    lastSolid = -1;
    for (let y = cropHeight - 1; y >= 0; y -= 1) {
      const idx = y * cropWidth + x;
      if (!cropBackgroundMask[idx]) {
        lastSolid = idx;
      } else if (lastSolid >= 0) {
        copyColor(lastSolid, idx);
      }
    }
  }

  const fallbackR = avgCount ? Math.round(avgR / avgCount) : 180;
  const fallbackG = avgCount ? Math.round(avgG / avgCount) : 180;
  const fallbackB = avgCount ? Math.round(avgB / avgCount) : 180;
  for (let index = 0; index < cropPixels; index += 1) {
    if (!cropBackgroundMask[index]) {
      continue;
    }
    const offset = index * 4;
    colorData[offset] = fallbackR;
    colorData[offset + 1] = fallbackG;
    colorData[offset + 2] = fallbackB;
    colorData[offset + 3] = 255;
  }

  colorContext.putImageData(colorImage, 0, 0);
  return colorCanvas;
}

function encodePathSegments(input) {
  return String(input || "")
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
}

function minBytesToHold(maxValue) {
  const absolute = Math.abs(Number(maxValue) || 0);
  if (absolute <= 0x7f) {
    return 1;
  }
  if (absolute <= 0x7fff) {
    return 2;
  }
  return 4;
}

function rgbArrayToColor(value, fallback = 0xffffff) {
  if (!Array.isArray(value) || value.length < 3) {
    return new THREE.Color(fallback);
  }
  return new THREE.Color(
    clamp01(value[0], 1),
    clamp01(value[1], 1),
    clamp01(value[2], 1)
  );
}

function getFloat32At(floatBuffer, byteOffset, length) {
  const start = Math.floor(byteOffset / 4);
  const end = start + length;
  if (start < 0 || end > floatBuffer.length) {
    return null;
  }
  return floatBuffer.subarray(start, end);
}

function parseMeshProps(meshesBuffer, boundsBuffer) {
  const ints = new Int32Array(meshesBuffer);
  const floats = new Float32Array(meshesBuffer);
  const boundsFloats = new Float32Array(boundsBuffer);

  const version = ints[0] || 0;
  const stride = ints[1] || 0;
  if (stride < 21) {
    throw new Error(`Unsupported mesh layout stride: ${stride}`);
  }

  const meshProps = [];
  for (let offset = 2; offset + 20 < ints.length; offset += stride) {
    const faceCount = ints[offset + 4];
    const vertexCount = ints[offset + 6];
    if (faceCount <= 0 || vertexCount <= 0) {
      continue;
    }

    const props = {
      nodeId: ints[offset],
      materialIdx: ints[offset + 1],
      useFaces16: ints[offset + 2] === 1,
      faceByteOffset: ints[offset + 3],
      faceCnt: faceCount,
      vertexByteOffset: ints[offset + 5],
      vertexCnt: vertexCount,
      normalByteOffset: ints[offset + 7],
      uv0ByteOffset: ints[offset + 8],
      uv1ByteOffset: ints[offset + 9],
      lightMapIdx: ints[offset + 10],
      uv1CoordUScale: floats[offset + 11],
      uv1CoordVScale: floats[offset + 12],
      uv1CoordUOffset: ints[offset + 13],
      uv1CoordVOffset: ints[offset + 14],
      transformByteOffset: ints[offset + 15],
      boundsByteOffset: ints[offset + 16],
      quantVertexRange: floats[offset + 17],
      quantVertexMax: ints[offset + 18],
      quantUv0Range: floats[offset + 19],
      quantUv0Max: ints[offset + 20],
      autoLightmapResolution: version >= 2 ? ints[offset + 21] : -1,
      bounds: null,
    };

    const boundsOffset = Math.floor(props.boundsByteOffset / 4);
    if (boundsOffset >= 0 && boundsOffset + 6 < boundsFloats.length) {
      const maxX = boundsFloats[boundsOffset];
      const maxY = boundsFloats[boundsOffset + 1];
      const maxZ = boundsFloats[boundsOffset + 2];
      const minX = boundsFloats[boundsOffset + 3];
      const minY = boundsFloats[boundsOffset + 4];
      const minZ = boundsFloats[boundsOffset + 5];

      if (
        Number.isFinite(maxX) &&
        Number.isFinite(maxY) &&
        Number.isFinite(maxZ) &&
        Number.isFinite(minX) &&
        Number.isFinite(minY) &&
        Number.isFinite(minZ)
      ) {
        props.bounds = new THREE.Box3(
          new THREE.Vector3(minX, minY, minZ),
          new THREE.Vector3(maxX, maxY, maxZ)
        );
      }
    }

    meshProps.push(props);
  }

  return meshProps;
}

function transformPoint(matrix, x, y, z, output, outputOffset) {
  output[outputOffset] = matrix[0] * x + matrix[1] * y + matrix[2] * z + matrix[3];
  output[outputOffset + 1] = matrix[4] * x + matrix[5] * y + matrix[6] * z + matrix[7];
  output[outputOffset + 2] = matrix[8] * x + matrix[9] * y + matrix[10] * z + matrix[11];
}

function decodeMeshGeometry(meshProps, buffers, views) {
  const vertexBytes = minBytesToHold(meshProps.quantVertexMax);
  const vertexFactor =
    meshProps.quantVertexMax !== 0
      ? meshProps.quantVertexRange / meshProps.quantVertexMax
      : 1;

  let vertexArray = null;
  let vertexElementOffset = 0;
  if (vertexBytes === 1) {
    vertexArray = views.vertices8;
    vertexElementOffset = meshProps.vertexByteOffset;
  } else if (vertexBytes === 2) {
    vertexArray = views.vertices16;
    vertexElementOffset = Math.floor(meshProps.vertexByteOffset / 2);
  } else {
    vertexArray = views.vertices32;
    vertexElementOffset = Math.floor(meshProps.vertexByteOffset / 4);
  }

  const vertexElementCount = meshProps.vertexCnt * 3;
  if (
    vertexElementOffset < 0 ||
    vertexElementOffset + vertexElementCount > vertexArray.length
  ) {
    return null;
  }

  const transformMatrix = getFloat32At(views.transforms, meshProps.transformByteOffset, 16);
  if (!transformMatrix) {
    return null;
  }

  const faceArray = meshProps.useFaces16 ? views.faces16 : views.faces32;
  if (!faceArray) {
    return null;
  }

  const faceElementOffset = Math.floor(
    meshProps.faceByteOffset / (meshProps.useFaces16 ? 2 : 4)
  );
  const faceElementCount = meshProps.faceCnt * 3;
  if (
    faceElementOffset < 0 ||
    faceElementOffset + faceElementCount > faceArray.length
  ) {
    return null;
  }

  const positions = new Float32Array(vertexElementCount);
  for (let vertexIndex = 0; vertexIndex < meshProps.vertexCnt; vertexIndex += 1) {
    const sourceIndex = vertexElementOffset + vertexIndex * 3;
    const x = vertexArray[sourceIndex] * vertexFactor;
    const y = vertexArray[sourceIndex + 1] * vertexFactor;
    const z = vertexArray[sourceIndex + 2] * vertexFactor;
    transformPoint(transformMatrix, x, y, z, positions, vertexIndex * 3);
  }

  const indices = new Uint32Array(faceElementCount);
  for (let i = 0; i < faceElementCount; i += 1) {
    const rawIndex = faceArray[faceElementOffset + i];
    indices[i] = rawIndex < meshProps.vertexCnt ? rawIndex : 0;
  }

  let uvs = null;
  if (meshProps.uv0ByteOffset >= 0 && views.uvsF32 && views.uvsU16) {
    uvs = new Float32Array(meshProps.vertexCnt * 2);

    if (meshProps.quantUv0Max === 0) {
      const uvElementOffset = Math.floor(meshProps.uv0ByteOffset / 4);
      const uvElementCount = meshProps.vertexCnt * 2;
      if (uvElementOffset + uvElementCount <= views.uvsF32.length) {
        for (let i = 0; i < uvElementCount; i += 1) {
          uvs[i] = views.uvsF32[uvElementOffset + i];
        }
      }
    } else {
      const uvFactor =
        meshProps.quantUv0Max !== 0 ? meshProps.quantUv0Range / meshProps.quantUv0Max : 1;
      const uvElementOffset = Math.floor(meshProps.uv0ByteOffset / 2);
      const uvElementCount = meshProps.vertexCnt * 2;
      if (uvElementOffset + uvElementCount <= views.uvsU16.length) {
        for (let i = 0; i < uvElementCount; i += 1) {
          uvs[i] = views.uvsU16[uvElementOffset + i] * uvFactor;
        }
      }
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  if (uvs) {
    geometry.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
  }
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Request failed: ${response.status} (${url})`);
  }
  return response.json();
}

async function fetchBuffer(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Request failed: ${response.status} (${url})`);
  }
  return response.arrayBuffer();
}

function buildSceneTextureCandidates(textureDefinition) {
  const id = encodePathSegments(textureDefinition.id);
  const extension = textureDefinition.stdExt || textureDefinition.rawExt || "jpg";
  const formats = Array.isArray(textureDefinition.webFormats)
    ? textureDefinition.webFormats
    : [];
  const candidates = [];

  for (const format of formats) {
    if (String(format).endsWith("/std")) {
      candidates.push(`${sceneBaseUrl}img/${format}/${id}.${extension}`);
    }
  }

  candidates.push(`${sceneBaseUrl}img/small/std/${id}.${extension}`);
  candidates.push(`${sceneBaseUrl}img/large/std/${id}.${extension}`);
  candidates.push(`${sceneBaseUrl}${id}.${extension}`);

  return Array.from(new Set(candidates));
}

function loadTextureFromCandidates(loader, candidates) {
  const uniqueCandidates = Array.from(new Set(candidates.filter(Boolean)));
  return new Promise((resolve) => {
    let pointer = 0;

    const attempt = () => {
      if (pointer >= uniqueCandidates.length) {
        resolve(null);
        return;
      }

      const url = uniqueCandidates[pointer];
      pointer += 1;

      loader.load(
        url,
        (texture) => {
          texture.userData.sourceUrl = url;
          resolve(texture);
        },
        undefined,
        () => {
          attempt();
        }
      );
    };

    attempt();
  });
}

async function loadSceneTexture(textureDefinition) {
  const cacheKey = `scene:${textureDefinition.id}:${textureDefinition.stdExt || ""}:${
    Array.isArray(textureDefinition.webFormats)
      ? textureDefinition.webFormats.join("|")
      : ""
  }`;
  if (runtime.sceneTextureCache.has(cacheKey)) {
    return runtime.sceneTextureCache.get(cacheKey);
  }

  const texturePromise = (async () => {
    const texture = await loadTextureFromCandidates(
      sceneTextureLoader,
      buildSceneTextureCandidates(textureDefinition)
    );

    if (!texture) {
      return null;
    }

    texture.colorSpace = THREE.SRGBColorSpace;
    texture.flipY = false;
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
    texture.needsUpdate = true;
    return texture;
  })();

  runtime.sceneTextureCache.set(cacheKey, texturePromise);
  return texturePromise;
}

async function resolveMaterialTexture(textureReference, textureLookup) {
  if (!textureReference || !textureReference.id) {
    return null;
  }

  if (textureReference.atlasId) {
    const atlasDefinition = textureLookup.get(textureReference.atlasId);
    if (!atlasDefinition) {
      return null;
    }

    const atlasTexture = await loadSceneTexture(atlasDefinition);
    if (!atlasTexture) {
      return null;
    }

    const atlasMaterialTexture = atlasTexture.clone();
    atlasMaterialTexture.flipY = false;
    atlasMaterialTexture.wrapS = THREE.RepeatWrapping;
    atlasMaterialTexture.wrapT = THREE.RepeatWrapping;

    const scale = Array.isArray(textureReference.atlasScale)
      ? textureReference.atlasScale
      : [1, 1];
    const offset = Array.isArray(textureReference.atlasOffset)
      ? textureReference.atlasOffset
      : [0, 0];

    atlasMaterialTexture.repeat.set(
      Number.isFinite(scale[0]) ? scale[0] : 1,
      Number.isFinite(scale[1]) ? scale[1] : 1
    );
    atlasMaterialTexture.offset.set(
      Number.isFinite(offset[0]) ? offset[0] : 0,
      Number.isFinite(offset[1]) ? offset[1] : 0
    );
    atlasMaterialTexture.needsUpdate = true;
    return atlasMaterialTexture;
  }

  return loadSceneTexture(textureReference);
}

function materialConfigFromSceneEntry(sceneMaterial) {
  const materialName = String(sceneMaterial?.name || "").toLowerCase();
  const baseTextureId = String(sceneMaterial?.baseColorTexture?.id || "").toLowerCase();
  const forceDoubleSidedExteriorCard =
    /shallow-sea|sea-waves-explosion|duo-botanical/.test(materialName) ||
    /shallow-sea|sea-waves-explosion|duo-botanical/.test(baseTextureId);

  return {
    color: rgbArrayToColor(sceneMaterial.baseColor, 0xffffff),
    roughness: clamp01(sceneMaterial.roughness, 0.5),
    metalness: clamp01(sceneMaterial.metallic, 0),
    transparent: Number(sceneMaterial.opacity) < 1,
    opacity: Number.isFinite(Number(sceneMaterial.opacity))
      ? Number(sceneMaterial.opacity)
      : 1,
    side:
      forceDoubleSidedExteriorCard || sceneMaterial.doubleSided
        ? THREE.DoubleSide
        : THREE.FrontSide,
    emissive: sceneMaterial.emissive ? rgbArrayToColor(sceneMaterial.baseColor, 0x000000) : null,
    emissiveIntensity: Number.isFinite(Number(sceneMaterial.emissionStrength))
      ? Number(sceneMaterial.emissionStrength)
      : 1,
  };
}

function buildTextureLookup(sceneJson) {
  const textureLookup = new Map();
  for (const atlas of sceneJson.atlases || []) {
    textureLookup.set(atlas.id, atlas);
  }
  for (const material of sceneJson.materials || []) {
    if (material.baseColorTexture?.id) {
      textureLookup.set(material.baseColorTexture.id, material.baseColorTexture);
    }
  }
  for (const sky of sceneJson.skies || []) {
    if (sky.texture?.id) {
      textureLookup.set(sky.texture.id, sky.texture);
    }
  }
  return textureLookup;
}

async function buildMaterialMap(sceneJson, usedMaterialIndexes, textureLookup) {

  const fallback = new THREE.MeshStandardMaterial({
    color: 0xa49a90,
    roughness: 0.7,
    metalness: 0.05,
  });

  await Promise.all(
    usedMaterialIndexes.map(async (index) => {
      const source = sceneJson.materials?.[index];
      if (!source) {
        runtime.materialByIndex.set(index, fallback);
        return;
      }

      const config = materialConfigFromSceneEntry(source);
      const material = new THREE.MeshStandardMaterial({
        color: config.color,
        roughness: config.roughness,
        metalness: config.metalness,
        transparent: config.transparent,
        opacity: config.opacity,
        side: config.side,
      });

      if (config.emissive) {
        material.emissive = config.emissive;
        material.emissiveIntensity = config.emissiveIntensity;
      }

      const baseMap = await resolveMaterialTexture(source.baseColorTexture, textureLookup);
      if (baseMap) {
        material.map = baseMap;
      }

      material.needsUpdate = true;
      runtime.materialByIndex.set(index, material);
    })
  );
}

function clearSceneExterior() {
  if (runtime.skyMesh) {
    scene.remove(runtime.skyMesh);
    runtime.skyMesh.geometry?.dispose();
    runtime.skyMesh.material?.dispose();
    runtime.skyMesh = null;
  }

  if (runtime.skyEnvironmentMap) {
    runtime.skyEnvironmentMap.dispose();
    runtime.skyEnvironmentMap = null;
  }

  scene.background = baseBackgroundColor;
  scene.environment = null;
}

function fitSkyToBounds(bounds) {
  if (!runtime.skyMesh) {
    return;
  }

  if (!bounds || bounds.isEmpty()) {
    runtime.skyRadius = MIN_SKY_RADIUS;
    runtime.skyMesh.scale.setScalar(runtime.skyRadius);
    return;
  }

  bounds.getCenter(scratchVecA);
  const maxX = Math.max(
    Math.abs(bounds.min.x - scratchVecA.x),
    Math.abs(bounds.max.x - scratchVecA.x)
  );
  const maxY = Math.max(
    Math.abs(bounds.min.y - scratchVecA.y),
    Math.abs(bounds.max.y - scratchVecA.y)
  );
  const maxZ = Math.max(
    Math.abs(bounds.min.z - scratchVecA.z),
    Math.abs(bounds.max.z - scratchVecA.z)
  );
  const sceneSpan = Math.sqrt(maxX * maxX + maxY * maxY + maxZ * maxZ);
  const radius = Math.max(
    MIN_SKY_RADIUS,
    (Number.isFinite(sceneSpan) ? sceneSpan : MIN_SKY_RADIUS) + SKY_DISTANCE_TO_SCENE
  );

  runtime.skyRadius = radius;
  runtime.skyMesh.scale.setScalar(runtime.skyRadius);
}

function syncSkyToCamera() {
  if (!runtime.skyMesh) {
    return;
  }
  runtime.skyMesh.position.copy(camera.position);
  runtime.skyMesh.updateMatrixWorld(true);
}

async function applySceneExterior(sceneJson, textureLookup) {
  clearSceneExterior();

  const firstSky = Array.isArray(sceneJson.skies) ? sceneJson.skies[0] : null;
  if (!firstSky?.texture?.id) {
    runtime.exteriorMode = "none";
    refreshSceneMeta();
    return false;
  }

  const skyTexture = await resolveMaterialTexture(firstSky.texture, textureLookup);
  if (!skyTexture) {
    runtime.exteriorMode = "none";
    refreshSceneMeta();
    return false;
  }

  skyTexture.colorSpace = THREE.SRGBColorSpace;
  skyTexture.flipY = true;
  skyTexture.wrapS = THREE.RepeatWrapping;
  skyTexture.wrapT = THREE.ClampToEdgeWrapping;
  skyTexture.needsUpdate = true;

  const skyGeometry = new THREE.SphereGeometry(1, 64, 64);
  skyGeometry.scale(1, 1, -1);
  const skyMaterial = new THREE.MeshBasicMaterial({
    map: skyTexture,
    color: 0xffffff,
    side: THREE.FrontSide,
    toneMapped: false,
    fog: false,
  });
  skyMaterial.depthWrite = false;
  const skyMesh = new THREE.Mesh(skyGeometry, skyMaterial);
  skyMesh.name = "slabcloud-sky";
  skyMesh.frustumCulled = false;
  skyMesh.renderOrder = -1000;
  scene.add(skyMesh);
  runtime.skyMesh = skyMesh;
  fitSkyToBounds(runtime.bounds);
  syncSkyToCamera();

  let yawRadians = 0;
  const yawDegrees = Number(firstSky.yawRotation);
  if (Number.isFinite(yawDegrees)) {
    yawRadians = THREE.MathUtils.degToRad(yawDegrees);
  }

  // Source scenes define equirect skies in Y-up space; this viewer is Z-up.
  // Rotate the sky dome into Z-up, then apply authored yaw around Z.
  const zUpSkyQuat = new THREE.Quaternion().setFromAxisAngle(
    new THREE.Vector3(1, 0, 0),
    Math.PI / 2
  );
  const skyYawQuat = new THREE.Quaternion().setFromAxisAngle(
    new THREE.Vector3(0, 0, 1),
    yawRadians
  );
  skyMesh.quaternion.copy(skyYawQuat).multiply(zUpSkyQuat);

  const environmentMap = skyTexture.clone();
  environmentMap.mapping = THREE.EquirectangularReflectionMapping;
  environmentMap.colorSpace = THREE.SRGBColorSpace;
  environmentMap.flipY = true;
  environmentMap.wrapS = THREE.RepeatWrapping;
  environmentMap.wrapT = THREE.ClampToEdgeWrapping;
  environmentMap.needsUpdate = true;
  runtime.skyEnvironmentMap = environmentMap;
  scene.environment = environmentMap;

  if (scene.environmentRotation) {
    scene.environmentRotation.set(0, 0, yawRadians);
  }
  if (scene.backgroundRotation) {
    scene.backgroundRotation.set(0, 0, 0);
  }

  if (scene.background !== baseBackgroundColor) {
    scene.background = baseBackgroundColor;
  }

  if (!Number.isFinite(yawDegrees)) {
    if (scene.environmentRotation) {
      scene.environmentRotation.set(0, 0, 0);
    }
  }

  runtime.exteriorMode = "sky";
  refreshSceneMeta();
  return true;
}

function extractCountertopMaterialNames(configJson) {
  const names = new Set();
  const targetGroups = configJson?.targetGroups || {};
  const selectionGroups = configJson?.selectionGroups || {};
  const countertopTargets = Array.isArray(selectionGroups.countertops)
    ? selectionGroups.countertops
    : ["countertop"];

  countertopTargets.forEach((groupId) => {
    const group = targetGroups[groupId];
    if (!group || !Array.isArray(group.materials)) {
      return;
    }
    group.materials.forEach((name) => {
      if (name) {
        names.add(name);
      }
    });
  });

  return names;
}

function extractMaterialNameFromNodeConfig(configValue) {
  if (typeof configValue !== "string") {
    return "";
  }

  const source = configValue.trim();
  if (!source.startsWith("{")) {
    return "";
  }

  const endBrace = source.indexOf("}");
  if (endBrace <= 1) {
    return "";
  }

  return source.slice(1, endBrace).trim();
}

function extractCountertopNodeIds(sceneNodes, countertopMaterialNames) {
  const nodeIds = new Set();
  if (!Array.isArray(sceneNodes) || !countertopMaterialNames?.size) {
    return nodeIds;
  }

  const queue = [...sceneNodes];
  while (queue.length) {
    const node = queue.shift();
    if (!node || typeof node !== "object") {
      continue;
    }

    const configMaterialName =
      extractMaterialNameFromNodeConfig(node.config) ||
      extractMaterialNameFromNodeConfig(node.meshType);
    if (
      configMaterialName &&
      countertopMaterialNames.has(configMaterialName) &&
      Number.isInteger(node.id)
    ) {
      nodeIds.add(node.id);
    }

    if (Array.isArray(node.children) && node.children.length) {
      queue.push(...node.children);
    }
  }

  return nodeIds;
}

function applyBoundsToCamera(bounds) {
  if (bounds.isEmpty()) {
    return;
  }

  bounds.getCenter(scratchVecA);
  bounds.getSize(scratchVecB);
  const radius = Math.max(scratchVecB.x, scratchVecB.y, scratchVecB.z) * 0.7;
  const safeRadius = Number.isFinite(radius) && radius > 0 ? radius : 8;
  const halfX = scratchVecB.x * 0.5;
  const halfY = scratchVecB.y * 0.5;
  const halfZ = scratchVecB.z * 0.5;

  const clampWithinBounds = (target) => {
    const padX = Math.min(0.25, Math.max(0.02, scratchVecB.x * 0.03));
    const padY = Math.min(0.25, Math.max(0.02, scratchVecB.y * 0.03));
    const padZ = Math.min(0.2, Math.max(0.02, scratchVecB.z * 0.05));
    target.x = Math.min(Math.max(target.x, bounds.min.x + padX), bounds.max.x - padX);
    target.y = Math.min(Math.max(target.y, bounds.min.y + padY), bounds.max.y - padY);
    target.z = Math.min(Math.max(target.z, bounds.min.z + padZ), bounds.max.z - padZ);
  };

  runtime.defaultOrbitTarget.copy(scratchVecA);
  runtime.defaultOrbitPosition.copy(scratchVecA);
  runtime.defaultOrbitPosition.x += halfX * 0.42;
  runtime.defaultOrbitPosition.y -= halfY * 0.42;
  runtime.defaultOrbitPosition.z += halfZ * 0.18;
  clampWithinBounds(runtime.defaultOrbitPosition);

  runtime.defaultFpsPosition.copy(scratchVecA);
  runtime.defaultFpsPosition.y -= halfY * 0.28;
  runtime.defaultFpsPosition.z += halfZ * 0.08;
  clampWithinBounds(runtime.defaultFpsPosition);

  camera.near = 0.05;
  camera.far = Math.max(500, safeRadius * 90);
  camera.updateProjectionMatrix();
  resetCamera();
}

function applyAuthoredView(sceneJson) {
  const views = Array.isArray(sceneJson?.views) ? sceneJson.views : [];
  const preferredView = views.find((entry) => !entry?.hideFromMenu) || views[0];
  if (!preferredView) {
    return false;
  }

  const position = Array.isArray(preferredView.position) ? preferredView.position : [];
  const rotation = Array.isArray(preferredView.rotation) ? preferredView.rotation : [];
  const px = Number(position[0]);
  const py = Number(position[1]);
  const pz = Number(position[2]);
  const yawDeg = Number(rotation[0]);
  const pitchDeg = Number(rotation[1]);

  if (
    !Number.isFinite(px) ||
    !Number.isFinite(py) ||
    !Number.isFinite(pz) ||
    !Number.isFinite(yawDeg) ||
    !Number.isFinite(pitchDeg)
  ) {
    return false;
  }

  const yaw = THREE.MathUtils.degToRad(yawDeg);
  const pitch = THREE.MathUtils.degToRad(pitchDeg);
  const cosPitch = Math.cos(pitch);
  const forward = new THREE.Vector3(
    Math.cos(yaw) * cosPitch,
    Math.sin(yaw) * cosPitch,
    Math.sin(pitch)
  );

  if (forward.lengthSq() < 1e-8) {
    forward.set(1, 0, 0);
  } else {
    forward.normalize();
  }

  runtime.defaultOrbitPosition.set(px, py, pz);
  runtime.defaultOrbitTarget.copy(runtime.defaultOrbitPosition).add(forward);
  runtime.defaultFpsPosition.copy(runtime.defaultOrbitPosition);

  const authoredFov = Number(sceneJson?.camera?.fov);
  if (Number.isFinite(authoredFov) && authoredFov > 10 && authoredFov < 120) {
    camera.fov = authoredFov;
    camera.updateProjectionMatrix();
  }

  resetCamera();
  return true;
}

function resetCamera() {
  if (runtime.cameraMode === "fps") {
    camera.position.copy(runtime.defaultFpsPosition);
    camera.lookAt(runtime.defaultOrbitTarget);
    return;
  }

  camera.position.copy(runtime.defaultOrbitPosition);
  orbitControls.target.copy(runtime.defaultOrbitTarget);
  orbitControls.update();
}

function setCameraMode(mode) {
  runtime.cameraMode = mode;
  const isFps = mode === "fps";
  orbitControls.enabled = !isFps;

  if (!isFps && fpsControls.isLocked) {
    fpsControls.unlock();
  }

  if (dom.fpsHint) {
    dom.fpsHint.hidden = !isFps;
  }
  if (dom.cameraModeButton) {
    dom.cameraModeButton.textContent = `Camera: ${isFps ? "FPS" : "Orbit"}`;
  }
}

function isTypingElement() {
  const active = document.activeElement;
  if (!active) {
    return false;
  }

  const tag = String(active.tagName || "").toUpperCase();
  return tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA";
}

function updateFpsMovement(deltaSeconds) {
  if (runtime.cameraMode !== "fps" || !fpsControls.isLocked) {
    return;
  }

  const sprint = runtime.keyState.has("ShiftLeft") || runtime.keyState.has("ShiftRight");
  const speed = sprint ? 8.6 : 4.9;
  const forward =
    (runtime.keyState.has("KeyW") ? 1 : 0) - (runtime.keyState.has("KeyS") ? 1 : 0);
  const right =
    (runtime.keyState.has("KeyD") ? 1 : 0) - (runtime.keyState.has("KeyA") ? 1 : 0);
  const lift =
    (runtime.keyState.has("KeyE") ? 1 : 0) - (runtime.keyState.has("KeyQ") ? 1 : 0);

  if (forward !== 0) {
    fpsControls.moveForward(forward * speed * deltaSeconds);
  }
  if (right !== 0) {
    fpsControls.moveRight(right * speed * deltaSeconds);
  }
  if (lift !== 0) {
    camera.position.z += lift * speed * deltaSeconds;
  }
}

function resizeRenderer() {
  const width = window.innerWidth || 1;
  const height = window.innerHeight || 1;
  renderer.setSize(width, height, false);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
}

function populateTextureSelect(items, preferredTextureId) {
  if (!dom.textureSelect) {
    return;
  }

  dom.textureSelect.innerHTML = "";
  const entries = Array.isArray(items) ? items : [];

  entries.forEach((entry) => {
    const option = document.createElement("option");
    option.value = entry.file;
    option.textContent = `${entry.slabName} (${entry.material || "Stone"})`;
    dom.textureSelect.appendChild(option);
  });

  if (preferredTextureId && !entries.find((entry) => entry.file === preferredTextureId)) {
    const fallbackOption = document.createElement("option");
    fallbackOption.value = preferredTextureId;
    fallbackOption.textContent = `${preferredTextureId} (custom)`;
    dom.textureSelect.appendChild(fallbackOption);
  }

  if (preferredTextureId) {
    dom.textureSelect.value = preferredTextureId;
  }
  updateTexturePreview(dom.textureSelect.value || preferredTextureId || "");
}

async function loadTextureCatalog() {
  const list = await fetchJson(`${SLABCLOUD_PROXY_PREFIX}/api/textures/${company}`);
  if (!Array.isArray(list)) {
    return [];
  }

  return list
    .filter((entry) => entry && entry.file)
    .map((entry) => ({
      file: String(entry.file),
      slabName: String(entry.slabName || entry.file),
      material: String(entry.material || ""),
    }))
    .sort((a, b) => a.slabName.localeCompare(b.slabName));
}

async function loadCountertopTexture(textureId) {
  const normalized = String(textureId || "").trim();
  if (!normalized) {
    return null;
  }

  if (runtime.externalTextureCache.has(normalized)) {
    return runtime.externalTextureCache.get(normalized);
  }

  const encoded = encodeURIComponent(normalized);
  const candidates = [
    `${SLABCLOUD_PROXY_PREFIX}/scdata/textures/1024/${encoded}.jpg`,
    `${SLABCLOUD_PROXY_PREFIX}/scdata/textures/800/${encoded}.jpg`,
    `${SLABCLOUD_PROXY_PREFIX}/scdata/textures/100/${encoded}.jpg`,
  ];

  const texturePromise = (async () => {
    const loadedTexture = await loadTextureFromCandidates(externalTextureLoader, candidates);
    if (!loadedTexture) {
      return null;
    }

    let texture = loadedTexture;
    const processedCanvas = cropAndFillCountertopTextureImage(loadedTexture.image);
    if (processedCanvas) {
      const sourceUrl = loadedTexture.userData?.sourceUrl || "";
      loadedTexture.dispose();
      texture = new THREE.CanvasTexture(processedCanvas);
      texture.userData.sourceUrl = sourceUrl;
    }

    texture.colorSpace = THREE.SRGBColorSpace;
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.repeat.set(1.7, 1.7);
    texture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
    texture.needsUpdate = true;
    return texture;
  })();

  runtime.externalTextureCache.set(normalized, texturePromise);
  return texturePromise;
}

function texturePreviewUrl(textureId) {
  const normalized = String(textureId || "").trim();
  if (!normalized) {
    return "";
  }
  return `${SLABCLOUD_PROXY_PREFIX}/scdata/textures/800/${encodeURIComponent(normalized)}.jpg`;
}

function updateTexturePreview(textureId) {
  if (!dom.textureSelectPreview) {
    return;
  }

  const previewUrl = texturePreviewUrl(textureId);
  if (!previewUrl) {
    dom.textureSelectPreview.removeAttribute("src");
    dom.textureSelectPreview.alt = "No slab texture selected";
    return;
  }

  dom.textureSelectPreview.src = previewUrl;
  dom.textureSelectPreview.alt = `Preview for slab texture ${textureId}`;
}

function projectCountertopUvsWorld(meshes, uvScale = 0.22) {
  const safeScale = Number.isFinite(uvScale) && uvScale > 0 ? uvScale : 0.22;
  const worldPosition = new THREE.Vector3();
  const worldNormal = new THREE.Vector3();

  meshes.forEach((mesh) => {
    const geometry = mesh?.geometry;
    if (!geometry || !geometry.getAttribute) {
      return;
    }

    const position = geometry.getAttribute("position");
    if (!position) {
      return;
    }

    const normal = geometry.getAttribute("normal");
    const uvArray = new Float32Array(position.count * 2);
    mesh.updateMatrixWorld(true);
    const normalMatrix = new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld);

    for (let i = 0; i < position.count; i += 1) {
      worldPosition
        .set(position.getX(i), position.getY(i), position.getZ(i))
        .applyMatrix4(mesh.matrixWorld);

      let u = worldPosition.x * safeScale;
      let v = worldPosition.y * safeScale;

      if (normal) {
        worldNormal
          .set(normal.getX(i), normal.getY(i), normal.getZ(i))
          .applyMatrix3(normalMatrix)
          .normalize();

        const nx = Math.abs(worldNormal.x);
        const ny = Math.abs(worldNormal.y);
        const nz = Math.abs(worldNormal.z);

        if (ny >= nx && ny >= nz) {
          u = worldPosition.x * safeScale;
          v = worldPosition.z * safeScale;
        } else if (nx >= ny && nx >= nz) {
          u = worldPosition.y * safeScale;
          v = worldPosition.z * safeScale;
        } else {
          u = worldPosition.x * safeScale;
          v = worldPosition.y * safeScale;
        }
      }

      uvArray[i * 2] = u;
      uvArray[i * 2 + 1] = v;
    }

    geometry.setAttribute("uv", new THREE.BufferAttribute(uvArray, 2));
    geometry.attributes.uv.needsUpdate = true;
  });
}

function harmonizeCountertopNormals(
  meshes,
  positionTolerance = 0.002,
  upNormalThreshold = 0.55,
  flattenTopFaces = false
) {
  if (!Array.isArray(meshes) || !meshes.length) {
    return;
  }

  const safeTolerance =
    Number.isFinite(positionTolerance) && positionTolerance > 0
      ? positionTolerance
      : 0.002;
  const safeUpThreshold = Number.isFinite(upNormalThreshold)
    ? upNormalThreshold
    : 0.55;

  const bucketMap = new Map();
  const touchedNormals = new Set();
  const worldPosition = new THREE.Vector3();
  const worldNormal = new THREE.Vector3();
  const avgWorldNormal = new THREE.Vector3();
  const localNormal = new THREE.Vector3();
  const worldUp = new THREE.Vector3(0, 0, 1);
  const topFaceRefs = [];
  const facePosA = new THREE.Vector3();
  const facePosB = new THREE.Vector3();
  const facePosC = new THREE.Vector3();
  const faceEdgeAB = new THREE.Vector3();
  const faceEdgeAC = new THREE.Vector3();
  const faceWorldNormal = new THREE.Vector3();
  const meshWorldPos = new THREE.Vector3();

  meshes.forEach((mesh) => {
    const geometry = mesh?.geometry;
    if (!geometry || !geometry.getAttribute) {
      return;
    }

    mesh.updateMatrixWorld(true);

    const position = geometry.getAttribute("position");
    if (!position) {
      return;
    }

    let normal = geometry.getAttribute("normal");
    if (!normal) {
      geometry.computeVertexNormals();
      normal = geometry.getAttribute("normal");
    }
    if (!normal) {
      return;
    }

    const normalMatrix = new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld);
    const inverseNormalMatrix = new THREE.Matrix3().copy(normalMatrix).invert();
    let meshTopZ = -Infinity;
    let meshBottomZ = Infinity;
    for (let i = 0; i < position.count; i += 1) {
      meshWorldPos
        .set(position.getX(i), position.getY(i), position.getZ(i))
        .applyMatrix4(mesh.matrixWorld);
      if (meshWorldPos.z > meshTopZ) {
        meshTopZ = meshWorldPos.z;
      }
      if (meshWorldPos.z < meshBottomZ) {
        meshBottomZ = meshWorldPos.z;
      }
    }
    const meshHeight = Number.isFinite(meshTopZ) && Number.isFinite(meshBottomZ)
      ? Math.max(0, meshTopZ - meshBottomZ)
      : 0;
    const topPlaneTolerance = Math.max(safeTolerance * 0.35, meshHeight * 0.01);
    const topBandHeight = Math.max(safeTolerance * 10, 0.08);

    let topVertexMask = null;
    if (flattenTopFaces) {
      topVertexMask = new Uint8Array(position.count);
      const index = geometry.getIndex();
      const triangleCount = index
        ? Math.floor(index.count / 3)
        : Math.floor(position.count / 3);

      for (let tri = 0; tri < triangleCount; tri += 1) {
        const ia = index ? index.getX(tri * 3) : tri * 3;
        const ib = index ? index.getX(tri * 3 + 1) : tri * 3 + 1;
        const ic = index ? index.getX(tri * 3 + 2) : tri * 3 + 2;
        if (
          ia < 0 ||
          ib < 0 ||
          ic < 0 ||
          ia >= position.count ||
          ib >= position.count ||
          ic >= position.count
        ) {
          continue;
        }

        facePosA
          .set(position.getX(ia), position.getY(ia), position.getZ(ia))
          .applyMatrix4(mesh.matrixWorld);
        facePosB
          .set(position.getX(ib), position.getY(ib), position.getZ(ib))
          .applyMatrix4(mesh.matrixWorld);
        facePosC
          .set(position.getX(ic), position.getY(ic), position.getZ(ic))
          .applyMatrix4(mesh.matrixWorld);

        faceEdgeAB.copy(facePosB).sub(facePosA);
        faceEdgeAC.copy(facePosC).sub(facePosA);
        faceWorldNormal.copy(faceEdgeAB).cross(faceEdgeAC);
        if (faceWorldNormal.lengthSq() < 1e-12) {
          continue;
        }
        faceWorldNormal.normalize();
        const upAlignment = faceWorldNormal.dot(worldUp);
        if (
          !Number.isFinite(upAlignment) ||
          Math.abs(upAlignment) < safeUpThreshold
        ) {
          continue;
        }

        topVertexMask[ia] = 1;
        topVertexMask[ib] = 1;
        topVertexMask[ic] = 1;
      }
    }

    for (let i = 0; i < position.count; i += 1) {
      worldNormal
        .set(normal.getX(i), normal.getY(i), normal.getZ(i))
        .applyMatrix3(normalMatrix)
        .normalize();
      const normalUpAlignment = worldNormal.dot(worldUp);
      const qualifiesByNormal =
        Number.isFinite(normalUpAlignment) &&
        Math.abs(normalUpAlignment) >= safeUpThreshold;

      worldPosition
        .set(position.getX(i), position.getY(i), position.getZ(i))
        .applyMatrix4(mesh.matrixWorld);
      const qualifiesByHeight =
        Number.isFinite(meshTopZ) &&
        Number.isFinite(worldPosition.z) &&
        meshTopZ - worldPosition.z <= topPlaneTolerance;
      const qualifiesByTopFace =
        (Boolean(topVertexMask) && topVertexMask[i] === 1) ||
        (qualifiesByHeight && qualifiesByNormal);
      if (!qualifiesByNormal && !qualifiesByTopFace) {
        continue;
      }

      const keyX = Math.round(worldPosition.x / safeTolerance);
      const keyY = Math.round(worldPosition.y / safeTolerance);
      const key = qualifiesByTopFace
        ? `${keyX}|${keyY}|top|${Math.round(worldPosition.z / topBandHeight)}`
        : `${keyX}|${keyY}|${Math.round(worldPosition.z / safeTolerance)}`;

      let bucket = bucketMap.get(key);
      if (!bucket) {
        bucket = { sumX: 0, sumY: 0, sumZ: 0, refs: [] };
        bucketMap.set(key, bucket);
      }

      const sampledWorldNormal = qualifiesByTopFace
        ? worldUp
        : normalUpAlignment >= 0
        ? worldNormal
        : worldNormal.multiplyScalar(-1);
      bucket.sumX += sampledWorldNormal.x;
      bucket.sumY += sampledWorldNormal.y;
      bucket.sumZ += sampledWorldNormal.z;
      bucket.refs.push({
        normal,
        index: i,
        inverseNormalMatrix,
      });
      if (flattenTopFaces && qualifiesByTopFace) {
        topFaceRefs.push({
          normal,
          index: i,
          inverseNormalMatrix,
        });
      }
      touchedNormals.add(normal);
    }
  });

  bucketMap.forEach((bucket) => {
    if (!bucket.refs.length) {
      return;
    }

    avgWorldNormal.set(bucket.sumX, bucket.sumY, bucket.sumZ);
    if (avgWorldNormal.lengthSq() < 1e-10) {
      return;
    }
    avgWorldNormal.normalize();

    bucket.refs.forEach((ref) => {
      localNormal
        .copy(avgWorldNormal)
        .applyMatrix3(ref.inverseNormalMatrix)
        .normalize();
      ref.normal.setXYZ(ref.index, localNormal.x, localNormal.y, localNormal.z);
    });
  });

  if (flattenTopFaces && topFaceRefs.length) {
    topFaceRefs.forEach((ref) => {
      localNormal
        .copy(worldUp)
        .applyMatrix3(ref.inverseNormalMatrix)
        .normalize();
      ref.normal.setXYZ(ref.index, localNormal.x, localNormal.y, localNormal.z);
    });
  }

  touchedNormals.forEach((normal) => {
    normal.needsUpdate = true;
  });
}

function normalizeCountertopMaterial(material, texture) {
  material.map = texture;
  material.color.set(1, 1, 1);
  material.transparent = false;
  material.opacity = 1;
  material.alphaMap = null;
  material.side = material.side || THREE.FrontSide;
  material.toneMapped = false;
  material.needsUpdate = true;
}

function getCountertopOverrideMaterial(materialIndex, texture) {
  const existing = runtime.countertopOverrideMaterials.get(materialIndex);
  if (existing) {
    normalizeCountertopMaterial(existing, texture);
    return existing;
  }

  const sourceMaterial = runtime.materialByIndex.get(materialIndex);
  const overrideMaterial = new THREE.MeshBasicMaterial({
    map: texture,
    color: 0xffffff,
    side: sourceMaterial?.side || THREE.FrontSide,
    transparent: false,
    opacity: 1,
  });

  normalizeCountertopMaterial(overrideMaterial, texture);
  runtime.countertopOverrideMaterials.set(materialIndex, overrideMaterial);
  return overrideMaterial;
}

async function applyCountertopTexture(textureId) {
  const normalized = String(textureId || "").trim();
  if (!normalized) {
    setStatus("Select a slab texture before applying.", true);
    return;
  }

  if (!runtime.countertopMeshes.length) {
    setStatus("No countertop materials were detected for this scene.", true);
    return;
  }

  setStatus(`Applying countertop texture ${normalized}...`);
  const texture = await loadCountertopTexture(normalized);
  if (!texture) {
    setStatus(`Could not load countertop texture ${normalized}.`, true);
    return;
  }

  if (!runtime.countertopNormalsHarmonized) {
    harmonizeCountertopNormals(runtime.countertopMeshes, 0.012, 0.5, true);
    runtime.countertopNormalsHarmonized = true;
  }
  projectCountertopUvsWorld(runtime.countertopMeshes, 0.23);
  const usedMaterialIndexes = new Set();
  runtime.countertopMeshes.forEach((mesh) => {
    const materialIndex = Number(mesh?.userData?.materialIdx);
    if (!Number.isInteger(materialIndex)) {
      return;
    }
    usedMaterialIndexes.add(materialIndex);
    const overrideMaterial = getCountertopOverrideMaterial(materialIndex, texture);
    mesh.material = overrideMaterial;
  });
  runtime.countertopMaterialIndexes = Array.from(usedMaterialIndexes);
  runtime.countertopMaterials = runtime.countertopMaterialIndexes
    .map((materialIndex) => runtime.materialByIndex.get(materialIndex))
    .filter(Boolean);

  if (dom.textureSelect) {
    dom.textureSelect.value = normalized;
  }
  updateTexturePreview(normalized);

  setStatus(`Applied countertop texture ${normalized}.`);
}

async function buildScene() {
  const startedAt = performance.now();
  setStatus("Loading scene manifests and binary buffers...");

  const [
    sceneJson,
    configJson,
    meshesBuffer,
    boundsBuffer,
    faces16Buffer,
    faces32Buffer,
    verticesBuffer,
    transformsBuffer,
    uvs0Buffer,
  ] = await Promise.all([
    fetchJson(`${sceneBaseUrl}scene.json`),
    fetchJson(`${sceneBaseUrl}config.json`),
    fetchBuffer(`${sceneBaseUrl}meshes.buf`),
    fetchBuffer(`${sceneBaseUrl}bounds.buf`),
    fetchBuffer(`${sceneBaseUrl}faces16.buf`),
    fetchBuffer(`${sceneBaseUrl}faces.buf`),
    fetchBuffer(`${sceneBaseUrl}vertices.buf`),
    fetchBuffer(`${sceneBaseUrl}transforms.buf`),
    fetchBuffer(`${sceneBaseUrl}uvs0.buf`),
  ]);

  runtime.sceneJson = sceneJson;
  runtime.configJson = configJson;

  const meshProps = parseMeshProps(meshesBuffer, boundsBuffer);
  if (!meshProps.length) {
    throw new Error("No mesh entries were parsed from meshes.buf.");
  }

  const textureLookup = buildTextureLookup(sceneJson);
  setStatus("Loading exterior backdrop...");
  await applySceneExterior(sceneJson, textureLookup);

  setStatus(`Building material map (${sceneJson.materials?.length || 0} materials)...`);
  const usedMaterialIndexes = Array.from(
    new Set(meshProps.map((mesh) => mesh.materialIdx).filter((index) => index >= 0))
  ).sort((a, b) => a - b);
  await buildMaterialMap(sceneJson, usedMaterialIndexes, textureLookup);

  const views = {
    faces16: faces16Buffer.byteLength ? new Uint16Array(faces16Buffer) : null,
    faces32: faces32Buffer.byteLength ? new Uint32Array(faces32Buffer) : null,
    vertices8: new Int8Array(verticesBuffer),
    vertices16: new Int16Array(verticesBuffer),
    vertices32: new Int32Array(verticesBuffer),
    transforms: new Float32Array(transformsBuffer),
    uvsU16: uvs0Buffer.byteLength ? new Uint16Array(uvs0Buffer) : null,
    uvsF32: uvs0Buffer.byteLength ? new Float32Array(uvs0Buffer) : null,
  };

  setStatus(`Decoding geometry (${meshProps.length} mesh records)...`);
  runtime.bounds.makeEmpty();
  runtime.meshesByMaterialIndex = new Map();
  runtime.meshesByNodeId = new Map();

  let builtMeshes = 0;
  let skippedMeshes = 0;
  for (let index = 0; index < meshProps.length; index += 1) {
    const props = meshProps[index];
    const geometry = decodeMeshGeometry(props, null, views);
    if (!geometry) {
      skippedMeshes += 1;
      continue;
    }

    const material =
      runtime.materialByIndex.get(props.materialIdx) ||
      new THREE.MeshStandardMaterial({ color: 0x8e8478, roughness: 0.7 });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.userData.materialIdx = props.materialIdx;
    mesh.userData.nodeId = props.nodeId;
    worldRoot.add(mesh);

    if (!runtime.meshesByMaterialIndex.has(props.materialIdx)) {
      runtime.meshesByMaterialIndex.set(props.materialIdx, []);
    }
    runtime.meshesByMaterialIndex.get(props.materialIdx).push(mesh);
    if (!runtime.meshesByNodeId.has(props.nodeId)) {
      runtime.meshesByNodeId.set(props.nodeId, []);
    }
    runtime.meshesByNodeId.get(props.nodeId).push(mesh);

    if (props.bounds && !props.bounds.isEmpty()) {
      runtime.bounds.union(props.bounds);
    } else if (geometry.boundingBox) {
      runtime.bounds.union(geometry.boundingBox);
    }

    builtMeshes += 1;
    if (builtMeshes % 40 === 0) {
      setStatus(`Decoding geometry (${builtMeshes}/${meshProps.length})...`);
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    }
  }

  if (runtime.bounds.isEmpty()) {
    runtime.bounds.setFromObject(worldRoot);
  }
  fitSkyToBounds(runtime.bounds);
  applyBoundsToCamera(runtime.bounds);
  applyAuthoredView(sceneJson);

  const countertopNameSet = extractCountertopMaterialNames(configJson);
  const countertopNodeIds = extractCountertopNodeIds(sceneJson.nodes, countertopNameSet);
  runtime.countertopMaterials = [];
  runtime.countertopMaterialIndexes = [];
  runtime.countertopNodeIds = [];
  runtime.countertopOverrideMaterials.forEach((material) => {
    material.dispose();
  });
  runtime.countertopOverrideMaterials.clear();
  runtime.countertopMeshes = [];
  runtime.countertopNodeIds = Array.from(countertopNodeIds);
  runtime.countertopMeshes = runtime.countertopNodeIds.flatMap(
    (nodeId) => runtime.meshesByNodeId.get(nodeId) || []
  );
  const countertopMaterialIndexes = new Set(
    runtime.countertopMeshes
      .map((mesh) => Number(mesh?.userData?.materialIdx))
      .filter((index) => Number.isInteger(index))
  );
  runtime.countertopMaterialIndexes = Array.from(countertopMaterialIndexes);
  runtime.countertopMaterials = runtime.countertopMaterialIndexes
    .map((materialIndex) => runtime.materialByIndex.get(materialIndex))
    .filter(Boolean);
  runtime.countertopNormalsHarmonized = false;

  const countertopNames = runtime.countertopMaterialIndexes
    .map((materialIndex) => sceneJson.materials?.[materialIndex]?.name)
    .filter(Boolean);
  setCountertopTargets(Array.from(new Set(countertopNames)));

  const durationSeconds = (performance.now() - startedAt) / 1000;
  setStatus(
    `Loaded ${builtMeshes} meshes (${skippedMeshes} skipped) in ${durationSeconds.toFixed(1)}s.`
  );
}

function wireUi() {
  refreshSceneMeta();

  dom.cameraModeButton?.addEventListener("click", () => {
    setCameraMode(runtime.cameraMode === "orbit" ? "fps" : "orbit");
  });

  dom.resetCameraButton?.addEventListener("click", () => {
    resetCamera();
  });

  dom.applySelectionButton?.addEventListener("click", async () => {
    await applyCountertopTexture(dom.textureSelect?.value || "");
  });

  dom.textureSelect?.addEventListener("change", async () => {
    updateTexturePreview(dom.textureSelect.value);
    await applyCountertopTexture(dom.textureSelect.value);
  });

  renderer.domElement.addEventListener("click", () => {
    if (runtime.cameraMode === "fps" && !fpsControls.isLocked) {
      fpsControls.lock();
    }
  });

  window.addEventListener("keydown", (event) => {
    if (isTypingElement()) {
      return;
    }
    runtime.keyState.add(event.code);
  });

  window.addEventListener("keyup", (event) => {
    runtime.keyState.delete(event.code);
  });

  fpsControls.addEventListener("lock", () => {
    setStatus("FPS controls locked. Press Esc to unlock pointer.");
  });

  fpsControls.addEventListener("unlock", () => {
    if (runtime.cameraMode === "fps") {
      setStatus("FPS controls unlocked. Click viewer to continue moving.");
    }
  });
}

const clock = new THREE.Clock();
function renderLoop() {
  const delta = Math.min(clock.getDelta(), 0.05);
  updateFpsMovement(delta);
  if (orbitControls.enabled) {
    orbitControls.update();
  }
  syncSkyToCamera();
  renderer.render(scene, camera);
  runtime.animId = window.requestAnimationFrame(renderLoop);
}

async function bootstrap() {
  wireUi();
  resizeRenderer();
  window.addEventListener("resize", resizeRenderer, { passive: true });
  renderLoop();

  try {
    await buildScene();

    setStatus("Loading texture catalog...");
    runtime.textureCatalog = await loadTextureCatalog();
    populateTextureSelect(runtime.textureCatalog, requestedCountertopTexture);

    if (requestedCountertopTexture) {
      await applyCountertopTexture(requestedCountertopTexture);
    } else if (dom.textureSelect?.value) {
      await applyCountertopTexture(dom.textureSelect.value);
    }
  } catch (error) {
    console.error(error);
    setStatus(error?.message || "Native viewer failed to load.", true);
  }
}

setCameraMode("orbit");
bootstrap();
