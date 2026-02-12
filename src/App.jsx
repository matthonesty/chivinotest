import { useEffect, useId, useMemo, useRef, useState } from "react";
import * as THREE from "three";

const COMPANY = "chivino";
const DATA_ENDPOINT = "/data/chivino-bundle.json";
const PLACEHOLDER_IMAGE = "/assets/placeholder.svg";

const slabFieldLabels = {
  InventoryID: "Item ID",
  Type: "Type",
  Status: "Status",
  Lot: "Lot",
  Rack: "Rack",
  Finish: "Finish",
  Thickness_Nominal: "Thickness",
  Length_Actual: "Length",
  Width_Actual: "Width",
  UsableA: "Usable A",
  UsableB: "Usable B",
  Color_Group: "Color Group",
  CreationDate: "Captured",
};

const slabFieldOrder = Object.keys(slabFieldLabels);

const edgeProfiles = [
  {
    id: "eased",
    label: "Eased",
    depthLabel: "Soft 1/8 in eased profile",
    path: "M32 32 H490 V74 Q490 98 466 98 H56 Q32 98 32 74 Z",
  },
  {
    id: "bullnose",
    label: "Bullnose",
    depthLabel: "Full rounded bullnose",
    path: "M32 32 H490 V66 C490 90 470 108 446 108 H76 C52 108 32 90 32 66 Z",
  },
  {
    id: "beveled",
    label: "Beveled",
    depthLabel: "45 degree beveled edge",
    path: "M32 32 H490 V58 L458 98 H64 L32 58 Z",
  },
  {
    id: "ogee",
    label: "Ogee",
    depthLabel: "Decorative ogee contour",
    path: "M32 32 H490 V68 C490 74 478 76 470 80 C460 84 458 94 448 98 H74 C62 94 60 84 50 80 C42 76 32 74 32 68 Z",
  },
];

function slugify(value) {
  if (!value) {
    return "";
  }

  return String(value)
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^\w-]+/g, "")
    .replace(/--+/g, "-");
}

function parseHashRoute(hash) {
  const clean = String(hash || "").replace(/^#/, "").trim();
  if (!clean) {
    return null;
  }

  const [materialSlug, assetSlug] = clean.split("/");
  return {
    materialSlug: materialSlug ? decodeURIComponent(materialSlug) : "",
    assetSlug: assetSlug
      ? decodeURIComponent(assetSlug)
      : decodeURIComponent(materialSlug || ""),
  };
}

function firstText(value, fallback = "Not listed") {
  if (Array.isArray(value)) {
    const match = value.find((item) => item !== null && item !== undefined && item !== "");
    return match !== undefined ? String(match) : fallback;
  }

  if (value === null || value === undefined || value === "") {
    return fallback;
  }

  return String(value);
}

function toNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatValue(value) {
  if (value === null || value === undefined || value === "") {
    return "Not listed";
  }

  return String(value);
}

function formatMeters(value) {
  const meters = toNumber(value);
  if (meters === null) {
    return formatValue(value);
  }

  const inches = meters * 39.3701;
  return `${meters.toFixed(2)} m / ${inches.toFixed(1)} in`;
}

function formatDate(value) {
  if (!value) {
    return "Not listed";
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return String(value);
  }

  return parsed.toLocaleString();
}

function slabFieldValue(slab, field) {
  const value = slab[field];

  if (field === "Length_Actual" || field === "Width_Actual") {
    return formatMeters(value);
  }

  if (field === "CreationDate") {
    return formatDate(value);
  }

  return formatValue(value);
}

function textureImage(textureId) {
  return textureId ? `/assets/textures/${textureId}.jpg` : null;
}

function normalizeSlabId(value) {
  return String(value || "").trim().toLowerCase();
}

function slabImage(slabId, variant = "thumb") {
  const normalizedId = normalizeSlabId(slabId);
  if (!normalizedId) {
    return null;
  }

  if (variant === "full") {
    return `/assets/slabs/full/${normalizedId}.jpg`;
  }

  return `/assets/slabs/thumb/${normalizedId}.jpg`;
}

function primarySlabId(asset, product) {
  const fromProductPrimary = product?.primarySlabId;
  if (fromProductPrimary) {
    return fromProductPrimary;
  }

  const preferred = (product?.slabs || []).find(
    (slab) => slab && slab.SlabID && slab.scColor !== "blank"
  );
  if (preferred?.SlabID) {
    return preferred.SlabID;
  }

  if (product?.slabs?.[0]?.SlabID) {
    return product.slabs[0].SlabID;
  }

  return asset?.SlabID || null;
}

function assetCardImage(asset) {
  return (
    textureImage(asset?.textureId) ||
    slabImage(asset?.SlabID, "thumb") ||
    slabImage(asset?.SlabID, "full") ||
    PLACEHOLDER_IMAGE
  );
}

function heroImage(asset, product) {
  const slabId = primarySlabId(asset, product);
  return (
    textureImage(product?.textureId || asset?.textureId) ||
    slabImage(slabId, "full") ||
    slabImage(slabId, "thumb") ||
    PLACEHOLDER_IMAGE
  );
}

function parseThicknessCentimeters(label) {
  const source = firstText(label, "3cm");
  const match = source.match(/(\d+(\.\d+)?)/);
  if (!match) {
    return 3;
  }

  const value = Number(match[1]);
  return Number.isFinite(value) ? value : 3;
}

function AssetCard({ asset, isActive, onSelect, delayIndex }) {
  const slabCount = toNumber(asset.count);

  return (
    <button
      type="button"
      className={`asset-card ${isActive ? "is-active" : ""}`}
      style={{ "--delay": `${Math.min(delayIndex, 20) * 45}ms` }}
      onClick={onSelect}
    >
      <div className="asset-media">
        <img
          loading="lazy"
          src={assetCardImage(asset)}
          alt={`${asset.Name} sample`}
          onError={(event) => {
            event.currentTarget.src = PLACEHOLDER_IMAGE;
          }}
        />
      </div>
      <div className="asset-content">
        <p className="asset-material">{asset.Material || "Material not listed"}</p>
        <h3>{asset.Name || "Unnamed Asset"}</h3>
        <div className="asset-meta">
          <span>{slabCount !== null ? `${slabCount} slabs` : "Count unavailable"}</span>
          <span>{asset.slug || "no-slug"}</span>
        </div>
      </div>
    </button>
  );
}

function RoomVisualizer({ assetName }) {
  return (
    <div className="tool-stage coming-soon-stage">
      <div className="coming-soon-body">
        <p className="coming-soon-title">Coming Soon</p>
        <p className="coming-soon-subtitle">
          Native visualizer module for {assetName}
        </p>
      </div>
      <p className="tool-caption">Visualizer module is in progress.</p>
    </div>
  );
}

function SlabThreeViewer({ textureUrl, thicknessLabel }) {
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return undefined;
    }

    const renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: true,
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

    const scene = new THREE.Scene();
    scene.background = null;

    const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 50);
    camera.position.set(0, 0.6, 3.6);

    const ambient = new THREE.AmbientLight(0xffe9cc, 0.8);
    scene.add(ambient);

    const keyLight = new THREE.DirectionalLight(0xffffff, 1);
    keyLight.position.set(2, 3, 2);
    scene.add(keyLight);

    const fillLight = new THREE.DirectionalLight(0x9bc4e2, 0.45);
    fillLight.position.set(-2, 1.4, -1.8);
    scene.add(fillLight);

    const thicknessCm = parseThicknessCentimeters(thicknessLabel);
    const depth = Math.max(0.05, thicknessCm / 40);

    const geometry = new THREE.BoxGeometry(2.7, 1.55, depth);
    const sideMaterial = new THREE.MeshStandardMaterial({
      color: 0xd8b896,
      roughness: 0.65,
      metalness: 0.08,
    });
    const faceMaterialA = new THREE.MeshStandardMaterial({
      color: 0xe8ddcf,
      roughness: 0.44,
      metalness: 0.06,
    });
    const faceMaterialB = faceMaterialA.clone();

    const slabMesh = new THREE.Mesh(geometry, [
      sideMaterial,
      sideMaterial,
      sideMaterial,
      sideMaterial,
      faceMaterialA,
      faceMaterialB,
    ]);
    slabMesh.rotation.x = -0.16;
    slabMesh.rotation.y = -0.5;
    scene.add(slabMesh);

    const plane = new THREE.Mesh(
      new THREE.PlaneGeometry(7, 7),
      new THREE.MeshStandardMaterial({
        color: 0x12171c,
        roughness: 1,
        metalness: 0,
      })
    );
    plane.position.set(0, -1.3, 0);
    plane.rotation.x = -Math.PI / 2;
    scene.add(plane);

    const loader = new THREE.TextureLoader();
    let disposedTexture = null;

    if (textureUrl && textureUrl !== PLACEHOLDER_IMAGE) {
      loader.load(
        textureUrl,
        (texture) => {
          texture.colorSpace = THREE.SRGBColorSpace;
          texture.wrapS = THREE.ClampToEdgeWrapping;
          texture.wrapT = THREE.ClampToEdgeWrapping;
          faceMaterialA.map = texture;
          faceMaterialB.map = texture;
          faceMaterialA.needsUpdate = true;
          faceMaterialB.needsUpdate = true;
          disposedTexture = texture;
        },
        undefined,
        () => {}
      );
    }

    let width = 1;
    let height = 1;
    const resize = () => {
      const nextWidth = canvas.clientWidth || 1;
      const nextHeight = canvas.clientHeight || 1;
      if (nextWidth === width && nextHeight === height) {
        return;
      }

      width = nextWidth;
      height = nextHeight;
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    };

    let targetX = -0.16;
    let targetY = -0.5;

    const onMove = (event) => {
      const rect = canvas.getBoundingClientRect();
      const px = (event.clientX - rect.left) / rect.width - 0.5;
      const py = (event.clientY - rect.top) / rect.height - 0.5;
      targetY = px * 1.1;
      targetX = py * 0.45;
    };

    const onLeave = () => {
      targetX = -0.16;
      targetY = -0.5;
    };

    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerleave", onLeave);

    let frame = 0;
    const render = () => {
      resize();
      slabMesh.rotation.x += (targetX - slabMesh.rotation.x) * 0.08;
      slabMesh.rotation.y += (targetY - slabMesh.rotation.y) * 0.08;
      renderer.render(scene, camera);
      frame = window.requestAnimationFrame(render);
    };
    render();

    return () => {
      window.cancelAnimationFrame(frame);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerleave", onLeave);
      geometry.dispose();
      sideMaterial.dispose();
      faceMaterialA.dispose();
      faceMaterialB.dispose();
      if (disposedTexture) {
        disposedTexture.dispose();
      }
      renderer.dispose();
    };
  }, [textureUrl, thicknessLabel]);

  return (
    <div className="tool-stage three-stage">
      <canvas ref={canvasRef} className="three-canvas" />
      <p className="tool-caption">3D Slab: move cursor over the model to inspect.</p>
    </div>
  );
}

function EdgeDesigner({ textureUrl }) {
  const [profileId, setProfileId] = useState("eased");
  const patternId = useId().replace(/:/g, "-");
  const current = edgeProfiles.find((profile) => profile.id === profileId) || edgeProfiles[0];

  return (
    <div className="tool-stage edge-stage">
      <div className="edge-switches" role="tablist" aria-label="Edge profiles">
        {edgeProfiles.map((profile) => (
          <button
            key={profile.id}
            type="button"
            className={`edge-switch ${profile.id === current.id ? "is-active" : ""}`}
            onClick={() => setProfileId(profile.id)}
          >
            {profile.label}
          </button>
        ))}
      </div>

      <svg viewBox="0 0 520 170" className="edge-canvas" aria-label={`${current.label} edge`}>
        <defs>
          <pattern id={patternId} width="520" height="170" patternUnits="userSpaceOnUse">
            <image
              href={textureUrl}
              width="520"
              height="170"
              preserveAspectRatio="xMidYMid slice"
            />
          </pattern>
          <linearGradient id={`${patternId}-shade`} x1="0%" x2="0%" y1="0%" y2="100%">
            <stop offset="0%" stopColor="rgba(255,255,255,0.26)" />
            <stop offset="100%" stopColor="rgba(0,0,0,0.25)" />
          </linearGradient>
        </defs>

        <rect x="0" y="0" width="520" height="170" fill="#0f1419" />
        <path d={current.path} fill={`url(#${patternId})`} stroke="#f5ddbf" strokeWidth="2" />
        <path d={current.path} fill={`url(#${patternId}-shade)`} />
      </svg>

      <p className="tool-caption">Edge Preview: {current.depthLabel}</p>
    </div>
  );
}

export default function App() {
  const [bundle, setBundle] = useState(null);
  const [dataStatus, setDataStatus] = useState("loading");
  const [dataError, setDataError] = useState("");
  const [searchValue, setSearchValue] = useState("");
  const [selectedMaterial, setSelectedMaterial] = useState("All Materials");
  const [selectedSlug, setSelectedSlug] = useState(null);
  const [activeTool, setActiveTool] = useState("visualizer");

  const [hashRoute, setHashRoute] = useState(() =>
    parseHashRoute(window.location.hash)
  );

  useEffect(() => {
    const onHashChange = () => setHashRoute(parseHashRoute(window.location.hash));
    window.addEventListener("hashchange", onHashChange);

    return () => {
      window.removeEventListener("hashchange", onHashChange);
    };
  }, []);

  useEffect(() => {
    let mounted = true;
    const controller = new AbortController();

    async function loadBundle() {
      setDataStatus("loading");
      try {
        const response = await fetch(DATA_ENDPOINT, { signal: controller.signal });
        if (!response.ok) {
          throw new Error(`Bundle request failed (${response.status})`);
        }
        const payload = await response.json();
        if (!mounted) {
          return;
        }

        const assets = Array.isArray(payload.inventory) ? payload.inventory : [];
        const sortedAssets = [...assets].sort((a, b) =>
          (a.Name || "").localeCompare(b.Name || "")
        );

        setBundle({
          ...payload,
          inventory: sortedAssets,
          productsBySlug: payload.productsBySlug || {},
        });
        setDataStatus("ready");

        const route = parseHashRoute(window.location.hash);
        let initialSlug = sortedAssets[0]?.slug || null;

        if (route?.assetSlug) {
          const match = sortedAssets.find(
            (asset) => slugify(asset.slug) === slugify(route.assetSlug)
          );
          if (match?.slug) {
            initialSlug = match.slug;
          }
        }

        if (route?.materialSlug) {
          const materialMatch = sortedAssets.find(
            (asset) => slugify(asset.Material) === slugify(route.materialSlug)
          );
          if (materialMatch?.Material) {
            setSelectedMaterial(materialMatch.Material);
          }
        }

        setSelectedSlug((current) => current || initialSlug);
      } catch (error) {
        if (error.name === "AbortError" || !mounted) {
          return;
        }
        setDataStatus("error");
        setDataError(error.message || "Could not load local asset bundle.");
      }
    }

    loadBundle();

    return () => {
      mounted = false;
      controller.abort();
    };
  }, []);

  const inventory = bundle?.inventory || [];
  const productsBySlug = bundle?.productsBySlug || {};

  const materialFilters = useMemo(() => {
    const canonical = new Map();
    inventory.forEach((item) => {
      const material = String(item.Material || "").trim();
      if (!material) {
        return;
      }
      const key = material.toLowerCase();
      if (!canonical.has(key)) {
        canonical.set(key, material);
      }
    });

    return ["All Materials", ...Array.from(canonical.values()).sort()];
  }, [inventory]);

  useEffect(() => {
    if (!hashRoute || inventory.length === 0) {
      return;
    }

    const routeSlug = slugify(hashRoute.assetSlug);
    if (!routeSlug) {
      return;
    }

    const match = inventory.find((asset) => slugify(asset.slug) === routeSlug);
    if (!match) {
      return;
    }

    setSelectedSlug(match.slug);

    if (hashRoute.materialSlug) {
      const materialMatch = materialFilters.find(
        (material) => slugify(material) === slugify(hashRoute.materialSlug)
      );
      if (materialMatch) {
        setSelectedMaterial(materialMatch);
      }
    }
  }, [hashRoute, inventory, materialFilters]);

  const filteredAssets = useMemo(() => {
    const normalizedSearch = searchValue.trim().toLowerCase();

    return inventory
      .filter((asset) => {
        const materialMatch =
          selectedMaterial === "All Materials" || asset.Material === selectedMaterial;
        if (!materialMatch) {
          return false;
        }

        if (!normalizedSearch) {
          return true;
        }

        const haystack = [
          asset.Name,
          asset.Material,
          asset.slug,
          asset.SlabID,
          asset.count,
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();

        return haystack.includes(normalizedSearch);
      })
      .sort((a, b) => {
        const countDelta = (toNumber(b.count) || 0) - (toNumber(a.count) || 0);
        if (countDelta !== 0) {
          return countDelta;
        }
        return (a.Name || "").localeCompare(b.Name || "");
      });
  }, [inventory, searchValue, selectedMaterial]);

  useEffect(() => {
    if (!selectedSlug || inventory.length === 0) {
      return;
    }

    const selected = inventory.find((item) => item.slug === selectedSlug);
    if (!selected) {
      return;
    }

    const materialSegment = slugify(selected.Material || selectedMaterial || "stone");
    const nextHash = `#${materialSegment}/${slugify(selected.slug)}`;
    if (window.location.hash !== nextHash) {
      window.history.replaceState(null, "", nextHash);
    }
  }, [inventory, selectedMaterial, selectedSlug]);

  useEffect(() => {
    setActiveTool("visualizer");
  }, [selectedSlug]);

  const selectedAsset = useMemo(
    () => inventory.find((item) => item.slug === selectedSlug),
    [inventory, selectedSlug]
  );

  const selectedProduct = selectedSlug ? productsBySlug[selectedSlug] : null;
  const slabs = selectedProduct?.slabs || [];
  const totalSlabs = slabs.length || toNumber(selectedAsset?.count) || 0;
  const totalMaterials = materialFilters.length - 1;

  const displayName = firstText(selectedProduct?.name, selectedAsset?.Name || "Unnamed Asset");
  const displayMaterial = firstText(
    selectedProduct?.material,
    selectedAsset?.Material || "Not listed"
  );
  const displayThickness = firstText(
    selectedProduct?.thickness,
    slabs[0]?.Thickness_Nominal || "Not listed"
  );
  const displayFinish = firstText(selectedProduct?.finish, slabs[0]?.Finish || "Not listed");
  const previewImageUrl = heroImage(selectedAsset, selectedProduct);

  return (
    <div className="app-shell">
      <div className="ambient ambient-one" />
      <div className="ambient ambient-two" />

      <header className="masthead">
        <p className="eyebrow">Chivino Surfaces Proof of Concept</p>
        <h1>Asset Atlas</h1>
        <p className="subhead">
          Fully self-contained single page: all assets, details, and tool previews are local.
        </p>
      </header>

      <section className="controls-strip">
        <label className="search-control" htmlFor="asset-search">
          <span>Find an asset</span>
          <input
            id="asset-search"
            type="search"
            placeholder="Search by name, material, ID, or slug"
            value={searchValue}
            onChange={(event) => setSearchValue(event.target.value)}
          />
        </label>

        <div className="stat-strip">
          <span>{inventory.length} total assets</span>
          <span>{filteredAssets.length} visible</span>
          <span>{totalMaterials} material groups</span>
        </div>
      </section>

      <nav className="material-pills" aria-label="Filter by material">
        {materialFilters.map((material) => (
          <button
            key={material}
            type="button"
            className={`material-pill ${
              selectedMaterial === material ? "is-active" : ""
            }`}
            onClick={() => setSelectedMaterial(material)}
          >
            {material}
          </button>
        ))}
      </nav>

      <section className="inventory-layout">
        <div className="asset-grid-wrap">
          {dataStatus === "loading" && <p className="state-note">Loading local asset bundle...</p>}
          {dataStatus === "error" && <p className="state-note error">{dataError}</p>}
          {dataStatus === "ready" && filteredAssets.length === 0 && (
            <p className="state-note">No assets match the current filter.</p>
          )}

          <div className="asset-grid">
            {filteredAssets.map((asset, index) => (
              <AssetCard
                key={`${asset.slug}-${asset.SlabID || index}`}
                asset={asset}
                delayIndex={index}
                isActive={asset.slug === selectedSlug}
                onSelect={() => setSelectedSlug(asset.slug)}
              />
            ))}
          </div>
        </div>

        <aside className="details-panel">
          {!selectedAsset && (
            <div className="details-empty">
              <p>Select any asset card to inspect slab details.</p>
            </div>
          )}

          {selectedAsset && (
            <div className="details-shell">
              <div className="details-top">
                <p className="material-tag">{displayMaterial}</p>
                <h2>{displayName}</h2>
                <button
                  type="button"
                  className="close-button"
                  onClick={() => setSelectedSlug(null)}
                >
                  Clear selection
                </button>
              </div>

              <div className="hero-frame">
                <img
                  src={previewImageUrl}
                  alt={`${displayName} hero`}
                  onError={(event) => {
                    event.currentTarget.src = PLACEHOLDER_IMAGE;
                  }}
                />
              </div>

              <dl className="quick-facts">
                <div>
                  <dt>Name</dt>
                  <dd>{displayName}</dd>
                </div>
                <div>
                  <dt>Thickness</dt>
                  <dd>{displayThickness}</dd>
                </div>
                <div>
                  <dt>Material</dt>
                  <dd>{displayMaterial}</dd>
                </div>
                <div>
                  <dt>Finish</dt>
                  <dd>{displayFinish}</dd>
                </div>
                <div>
                  <dt>Available Slabs</dt>
                  <dd>{totalSlabs}</dd>
                </div>
                <div>
                  <dt>Asset Slug</dt>
                  <dd>{formatValue(selectedAsset.slug)}</dd>
                </div>
              </dl>

              <section className="tool-section">
                <div className="tool-tabs" role="tablist" aria-label="Asset tools">
                  <button
                    type="button"
                    className={activeTool === "visualizer" ? "is-active" : ""}
                    onClick={() => setActiveTool("visualizer")}
                  >
                    Visualizer
                  </button>
                  <button
                    type="button"
                    className={activeTool === "three" ? "is-active" : ""}
                    onClick={() => setActiveTool("three")}
                  >
                    3D View
                  </button>
                  <button
                    type="button"
                    className={activeTool === "edges" ? "is-active" : ""}
                    onClick={() => setActiveTool("edges")}
                  >
                    Edges
                  </button>
                </div>

                {activeTool === "visualizer" && (
                  <RoomVisualizer assetName={displayName} />
                )}
                {activeTool === "three" && (
                  <SlabThreeViewer
                    textureUrl={previewImageUrl}
                    thicknessLabel={displayThickness}
                  />
                )}
                {activeTool === "edges" && <EdgeDesigner textureUrl={previewImageUrl} />}
              </section>

              <section className="slab-section">
                <h3>Slab Assets in Detail ({totalSlabs})</h3>
                {slabs.length === 0 && (
                  <p className="state-note">No slab rows were returned for this asset.</p>
                )}

                {slabs.map((slab, index) => (
                  <details
                    key={slab.SlabID || slab.InventoryID || `${selectedAsset.slug}-${index}`}
                    className="slab-item"
                    open={index === 0}
                  >
                    <summary>
                      <span>{formatValue(slab.InventoryID)}</span>
                      <span>{formatValue(slab.Type)}</span>
                      <span>{formatValue(slab.Status)}</span>
                    </summary>

                    <div className="slab-item-body">
                      <dl className="slab-fields">
                        {slabFieldOrder.map((field) => (
                          <div key={`${slab.SlabID}-${field}`}>
                            <dt>{slabFieldLabels[field]}</dt>
                            <dd>{slabFieldValue(slab, field)}</dd>
                          </div>
                        ))}
                      </dl>
                    </div>
                  </details>
                ))}
              </section>
            </div>
          )}
        </aside>
      </section>
    </div>
  );
}
