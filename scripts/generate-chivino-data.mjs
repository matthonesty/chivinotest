import { access, mkdir, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";

const COMPANY = "chivino";
const API_ROOT = "https://slabcloud.com/api/v2";
const INVENTORY_URL = `${API_ROOT}/inventory/${COMPANY}`;
const PRODUCT_URL = (slug) =>
  `${API_ROOT}/product/${COMPANY}?slug=${encodeURIComponent(slug)}`;
const TEXTURE_SOURCE = "https://slabcloud.com/scdata/textures/1024";

const ROOT_DIR = path.resolve(process.cwd());
const DATA_DIR = path.join(ROOT_DIR, "public", "data");
const TEXTURE_DIR = path.join(ROOT_DIR, "public", "assets", "textures");
const SLAB_FULL_DIR = path.join(ROOT_DIR, "public", "assets", "slabs", "full");
const SLAB_THUMB_DIR = path.join(ROOT_DIR, "public", "assets", "slabs", "thumb");
const OUTPUT_FILE = path.join(DATA_DIR, `${COMPANY}-bundle.json`);

const CONCURRENCY = 8;

function normalizeArrayField(value) {
  if (Array.isArray(value)) {
    return value.filter(Boolean);
  }

  if (value === null || value === undefined || value === "") {
    return [];
  }

  return [String(value)];
}

function textureId(value) {
  if (Array.isArray(value)) {
    return value[0] || null;
  }

  if (typeof value === "string" && value) {
    return value;
  }

  return null;
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Request failed (${response.status}) for ${url}`);
  }

  return response.json();
}

async function fileExists(filePath) {
  try {
    await access(filePath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function worker(items, handler) {
  let index = 0;
  const results = new Array(items.length);

  async function runOne() {
    while (index < items.length) {
      const current = index;
      index += 1;
      results[current] = await handler(items[current], current);
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => runOne()));
  return results;
}

function normalizeSlabId(id) {
  return String(id || "").trim().toLowerCase();
}

async function downloadFile(url, outputPath) {
  if (await fileExists(outputPath)) {
    return "existing";
  }

  const response = await fetch(url);

  if (!response.ok) {
    return "failed";
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  await writeFile(outputPath, bytes);
  return "downloaded";
}

async function downloadTexture(id) {
  const url = `${TEXTURE_SOURCE}/${id}.jpg`;
  const outputPath = path.join(TEXTURE_DIR, `${id}.jpg`);
  return downloadFile(url, outputPath);
}

async function downloadSlabImage(id, variant) {
  const normalizedId = normalizeSlabId(id);
  if (!normalizedId) {
    return "failed";
  }

  if (variant === "thumb") {
    const url = `https://slabcloud.com/slabs/${COMPANY}/${normalizedId}_thumb.jpg`;
    const outputPath = path.join(SLAB_THUMB_DIR, `${normalizedId}.jpg`);
    return downloadFile(url, outputPath);
  }

  const url = `https://slabcloud.com/slabs/${COMPANY}/${normalizedId}.jpg`;
  const outputPath = path.join(SLAB_FULL_DIR, `${normalizedId}.jpg`);
  return downloadFile(url, outputPath);
}

async function main() {
  console.log("Preparing local folders...");
  await mkdir(DATA_DIR, { recursive: true });
  await mkdir(TEXTURE_DIR, { recursive: true });
  await mkdir(SLAB_FULL_DIR, { recursive: true });
  await mkdir(SLAB_THUMB_DIR, { recursive: true });

  console.log("Fetching inventory...");
  const inventoryPayload = await fetchJson(INVENTORY_URL);
  const inventory = Array.isArray(inventoryPayload.inventory)
    ? inventoryPayload.inventory
    : [];

  const uniqueAssets = [];
  const seenSlugs = new Set();

  inventory.forEach((asset) => {
    if (!asset.slug || seenSlugs.has(asset.slug)) {
      return;
    }
    seenSlugs.add(asset.slug);
    uniqueAssets.push(asset);
  });

  console.log(`Inventory assets: ${uniqueAssets.length}`);

  const productBySlug = {};
  let failedProducts = 0;

  await worker(uniqueAssets, async (asset, index) => {
    const slug = asset.slug;
    try {
      const product = await fetchJson(PRODUCT_URL(slug));
      const fallbackSlab = (Array.isArray(product.slabs) ? product.slabs : []).find(
        (slab) => slab && slab.scColor !== "blank"
      );
      const firstSlab = (Array.isArray(product.slabs) ? product.slabs : [])[0];

      const normalized = {
        slug,
        name: product.name || asset.Name || "",
        material: normalizeArrayField(product.material),
        thickness: normalizeArrayField(product.thickness),
        finish: normalizeArrayField(product.finish),
        textureId: textureId(product.texture) || textureId(asset.texture),
        primarySlabId: (fallbackSlab || firstSlab)?.SlabID || asset.SlabID || null,
        slabs: Array.isArray(product.slabs) ? product.slabs : [],
      };

      productBySlug[slug] = normalized;
    } catch (error) {
      failedProducts += 1;
      productBySlug[slug] = {
        slug,
        name: asset.Name || "",
        material: normalizeArrayField(asset.Material),
        thickness: [],
        finish: [],
        textureId: textureId(asset.texture),
        primarySlabId: asset.SlabID || null,
        slabs: [],
        error: error.message,
      };
    }

    if ((index + 1) % 25 === 0 || index + 1 === uniqueAssets.length) {
      console.log(`Fetched details ${index + 1}/${uniqueAssets.length}`);
    }
  });

  const textureIds = new Set();

  uniqueAssets.forEach((asset) => {
    const id = textureId(asset.texture);
    if (id) {
      textureIds.add(id);
    }
  });

  Object.values(productBySlug).forEach((product) => {
    const id = textureId(product.textureId);
    if (id) {
      textureIds.add(id);
    }
  });

  const textureList = Array.from(textureIds);
  console.log(`Downloading textures: ${textureList.length}`);

  let downloadedTextures = 0;
  let existingTextures = 0;
  let failedTextures = 0;

  await worker(textureList, async (id, index) => {
    const status = await downloadTexture(id);
    if (status === "downloaded") {
      downloadedTextures += 1;
    } else if (status === "existing") {
      existingTextures += 1;
    } else {
      failedTextures += 1;
    }

    if ((index + 1) % 40 === 0 || index + 1 === textureList.length) {
      console.log(`Textures ${index + 1}/${textureList.length}`);
    }
  });

  const slabIds = new Set();
  uniqueAssets.forEach((asset) => {
    if (asset.SlabID) {
      slabIds.add(normalizeSlabId(asset.SlabID));
    }
  });
  Object.values(productBySlug).forEach((product) => {
    if (Array.isArray(product.slabs)) {
      product.slabs.forEach((slab) => {
        if (slab && slab.SlabID) {
          slabIds.add(normalizeSlabId(slab.SlabID));
        }
      });
    }
    if (product.primarySlabId) {
      slabIds.add(normalizeSlabId(product.primarySlabId));
    }
  });

  const slabList = Array.from(slabIds);
  console.log(`Downloading slab images (full + thumb): ${slabList.length}`);

  let downloadedSlabFull = 0;
  let existingSlabFull = 0;
  let failedSlabFull = 0;
  let downloadedSlabThumb = 0;
  let existingSlabThumb = 0;
  let failedSlabThumb = 0;

  await worker(slabList, async (id, index) => {
    const fullStatus = await downloadSlabImage(id, "full");
    const thumbStatus = await downloadSlabImage(id, "thumb");

    if (fullStatus === "downloaded") {
      downloadedSlabFull += 1;
    } else if (fullStatus === "existing") {
      existingSlabFull += 1;
    } else {
      failedSlabFull += 1;
    }

    if (thumbStatus === "downloaded") {
      downloadedSlabThumb += 1;
    } else if (thumbStatus === "existing") {
      existingSlabThumb += 1;
    } else {
      failedSlabThumb += 1;
    }

    if ((index + 1) % 50 === 0 || index + 1 === slabList.length) {
      console.log(`Slab images ${index + 1}/${slabList.length}`);
    }
  });

  const output = {
    company: COMPANY,
    generatedAt: new Date().toISOString(),
    inventory: uniqueAssets.map((asset) => ({
      Name: asset.Name || "",
      Material: asset.Material || "",
      slug: asset.slug || "",
      SlabID: asset.SlabID || "",
      scColor: asset.scColor || "",
      count: asset.count || "0",
      textureId: textureId(asset.texture),
    })),
    productsBySlug: productBySlug,
    stats: {
      assets: uniqueAssets.length,
      textures: textureList.length,
      downloadedTextures,
      existingTextures,
      failedProducts,
      failedTextures,
      slabs: slabList.length,
      downloadedSlabFull,
      existingSlabFull,
      failedSlabFull,
      downloadedSlabThumb,
      existingSlabThumb,
      failedSlabThumb,
    },
  };

  await writeFile(OUTPUT_FILE, `${JSON.stringify(output, null, 2)}\n`);

  console.log("Complete.");
  console.log(`Output JSON: ${OUTPUT_FILE}`);
  console.log(
    `Products failed: ${failedProducts}, textures failed: ${failedTextures}, slab full failed: ${failedSlabFull}, slab thumb failed: ${failedSlabThumb}`
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
