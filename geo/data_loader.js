/* Hosted pages fetch compressed binary records; offline copies retain embedded data. */
window.loadOneidaData = async function () {
  const config = JSON.parse(document.getElementById("data").textContent);
  const widths = { t: 2, a: 1, c: 1, d: 2, h: 1, l: 2, u: 1, m: 1, i: 4,
    k: 2, s: 2, z: 4, q: 1, p: 1, f: 2, v: 2, r: 2 };
  const types = { 1: Uint8Array, 2: Uint16Array, 4: Uint32Array };
  let data;
  if (config.metadataUrl) {
    if (config.formatVersion !== 1) throw new Error("Unsupported map data version.");
    async function fetchAsset(url) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 180000);
      try {
        const response = await fetch(url, { signal: controller.signal });
        if (!response.ok) throw new Error(`Map data request failed (${response.status}).`);
        const buffer = await response.arrayBuffer();
        const bytes = new Uint8Array(buffer);
        // Hosts may apply Content-Encoding to .gz files; fetch then already decoded it.
        if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) return buffer;
        if (typeof DecompressionStream === "undefined") throw new Error("Please use an updated browser to open this map.");
        return await new Response(new Blob([buffer]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer();
      } finally { clearTimeout(timeout); }
    }
    const [metadata, binary] = await Promise.all([fetchAsset(config.metadataUrl), fetchAsset(config.recordsUrl)]);
    data = JSON.parse(new TextDecoder().decode(metadata));
    if (data.formatVersion !== 1 || binary.byteLength !== data.recordBytes) throw new Error("Incomplete map data. Please reload.");
    const records = {};
    for (const [key, width] of Object.entries(widths)) {
      const field = data.records[key];
      if (!field || field.width !== width || field.count !== data.total || !Number.isSafeInteger(field.offset)
          || field.offset < 0 || field.offset % 4 || field.offset + width * field.count > binary.byteLength) {
        throw new Error("Invalid map data. Please reload.");
      }
      records[key] = new types[width](binary, field.offset, field.count);
    }
    data.records = records;
  } else {
    data = config;
    for (const [key, width] of Object.entries(widths)) {
      const bytes = Uint8Array.from(atob(data.records[key]), ch => ch.charCodeAt(0));
      data.records[key] = new types[width](bytes.buffer);
      if (data.records[key].length !== data.total) throw new Error("Incomplete offline map data.");
    }
  }
  return data;
};
