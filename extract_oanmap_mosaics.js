//Import libraries
let fs = (global.fs) ? global.fs : require("fs");
let https = require("https");
let JSON5 = (global.JSON5) ? global.JSON5 : require("json5");
let path = (global.path) ? global.path : require("path");
let pngjs = (global.pngjs) ? global.pngjs : require("pngjs");
let zlib = require("zlib");


//Initialise functions
{
  if (!global.sites_ia_ras) global.sites_ia_ras = {};

  /**
   * Step A: Fetches OANMAP dictionaries (site types and chronological epochs) and traverses
   * federal districts and oblasts to collect all regional coordinate bounds across Russia.
   * @alias sites_ia_ras.A_fetchMetadata
   *
   * @param {Object} arg0_config_obj - Parsed configuration object from common/histmap/sites_ia_ras.json5.
   * @param {Object} [arg1_options]
   *
   * @returns {Promise<Object>} Metadata dictionary and regional coordinate list.
   */
  sites_ia_ras.A_fetchMetadata = async function (arg0_config_obj, arg1_options) {
    //Convert from parameters
    let config_obj = arg0_config_obj;
    let options = (arg1_options) ? arg1_options : {};

    //Declare local instance variables
    let agent_obj = options.agent_obj;
    let all_epochs_array = [];
    let all_oblasts_array = [];
    let all_points_array = [];
    let all_types_array = [];
    let api_base = "";
    let dicts_raw = null;
    let federal_districts_array = [];
    let z2_raw = null;

    //Guard clauses
    if (!config_obj || !config_obj.api_base_url) {
      console.error("[sites_ia_ras.A_fetchMetadata] Missing config_obj.api_base_url.");
      return null;
    }


    api_base = config_obj.api_base_url.replace(/\/+$/, "");
    dicts_raw = await sites_ia_ras.fetchJson(`${api_base}/dicts?regs`, config_obj, { agent_obj: agent_obj });
    if (!Array.isArray(dicts_raw)) {
      console.error("[sites_ia_ras.A_fetchMetadata] Unexpected /dicts?regs payload.");
      return null;
    }

    if (Array.isArray(dicts_raw[1])) {
      for (let i = 0; i < dicts_raw[1].length; i++) {
        let local_entry = dicts_raw[1][i];
        if (Array.isArray(local_entry) && local_entry.length >= 2)
          all_types_array.push({
            colour_hex: local_entry[5] ? String(local_entry[5]) : null,
            id: Number(local_entry[0]),
            name_ru: String(local_entry[1]).trim()
          });
      }
    }

    if (Array.isArray(dicts_raw[2])) {
      for (let i = 0; i < dicts_raw[2].length; i++) {
        let local_entry = dicts_raw[2][i];
        if (Array.isArray(local_entry) && local_entry.length >= 2)
          all_epochs_array.push({
            colour_hex: local_entry[5] ? String(local_entry[5]) : null,
            id: Number(local_entry[0]),
            name_ru: String(local_entry[1]).trim(),
            sort_order: Number(local_entry[2])
          });
      }
    }
    all_epochs_array.push({
      colour_hex: "b3b3b3",
      id: -1,
      name_ru: "Не указано",
      sort_order: -1
    });

    z2_raw = await sites_ia_ras.fetchJson(`${api_base}/rtile/2/1/0`, config_obj, { agent_obj: agent_obj });
    federal_districts_array = (Array.isArray(z2_raw) && Array.isArray(z2_raw[1])) ? z2_raw[1] : [];

    for (let i = 0; i < federal_districts_array.length; i++) {
      let local_fd = federal_districts_array[i];
      let local_fd_id = local_fd[0];
      let local_fd_reg = await sites_ia_ras.fetchJson(`${api_base}/reg?r=${local_fd_id}`, config_obj, { agent_obj: agent_obj });
      let local_payload = (Array.isArray(local_fd_reg)) ? local_fd_reg[1] : null;
      let local_children = (Array.isArray(local_payload) && Array.isArray(local_payload[8])) ? local_payload[8] : [];

      if (Number.isFinite(Number(local_fd[4])) && Number.isFinite(Number(local_fd[5])))
        all_points_array.push([Number(local_fd[4]), Number(local_fd[5])]);

      if (Array.isArray(local_payload) && Array.isArray(local_payload[4]))
        all_points_array.push([Number(local_payload[4][0]), Number(local_payload[4][1])]);

      for (let x = 0; x < local_children.length; x++) {
        let local_ch = local_children[x];
        all_oblasts_array.push({ id: local_ch[0], name_ru: local_ch[1] });
        if (Array.isArray(local_ch[4]))
          all_points_array.push([Number(local_ch[4][0]), Number(local_ch[4][1])]);
        if (Array.isArray(local_ch[6]) && local_ch[6].length >= 2) {
          all_points_array.push([Number(local_ch[6][0][0]), Number(local_ch[6][0][1])]);
          all_points_array.push([Number(local_ch[6][1][0]), Number(local_ch[6][1][1])]);
        }
      }
    }

    await sites_ia_ras.runPool(all_oblasts_array, config_obj.http_concurrency, async function (arg0_oblast_obj) {
      let local_ob = arg0_oblast_obj;
      let local_ob_reg = await sites_ia_ras.fetchJson(`${api_base}/reg?r=${local_ob.id}`, config_obj, { agent_obj: agent_obj });
      let local_payload = (Array.isArray(local_ob_reg)) ? local_ob_reg[1] : null;
      let local_children = (Array.isArray(local_payload) && Array.isArray(local_payload[8])) ? local_payload[8] : [];

      for (let i = 0; i < local_children.length; i++) {
        let local_ch = local_children[i];
        if (Array.isArray(local_ch[4]))
          all_points_array.push([Number(local_ch[4][0]), Number(local_ch[4][1])]);
        if (Array.isArray(local_ch[6]) && local_ch[6].length >= 2) {
          all_points_array.push([Number(local_ch[6][0][0]), Number(local_ch[6][0][1])]);
          all_points_array.push([Number(local_ch[6][1][0]), Number(local_ch[6][1][1])]);
        }
      }
    });

    //Return statement
    return {
      epochs_array: all_epochs_array,
      federal_districts_count: federal_districts_array.length,
      oblasts_count: all_oblasts_array.length,
      points_array: all_points_array,
      types_array: all_types_array
    };
  };


  /**
   * Step B: Discovers the exact set of active zoom-8 tiles containing markers across all periods
   * (with all site types selected) and validates the canonical unwrapped mosaic bounding box.
   * @alias sites_ia_ras.B_discoverActiveTileMask
   *
   * @param {Object} arg0_config_obj - Parsed configuration object.
   * @param {Object} arg1_metadata_obj - Output from {@link sites_ia_ras.A_fetchMetadata}.
   * @param {Object} [arg2_options]
   *
   * @returns {Promise<Object>} Active zoom-8 tile mask and mosaic grid dimensions.
   */
  sites_ia_ras.B_discoverActiveTileMask = async function (arg0_config_obj, arg1_metadata_obj, arg2_options) {
    //Convert from parameters
    let config_obj = arg0_config_obj;
    let metadata_obj = arg1_metadata_obj;
    let options = (arg2_options) ? arg2_options : {};

    //Declare local instance variables
    let active_marker_tiles_array = [];
    let agent_obj = options.agent_obj;
    let api_base = "";
    let candidate_keys_array = [];
    let candidate_set = null;
    let grid_size = 128;
    let max_tile_y = 0;
    let max_unwrapped_x = 0;
    let min_tile_y = 0;
    let min_unwrapped_x = 0;
    let observed_max_ux = -Infinity;
    let observed_max_y = -Infinity;
    let observed_min_ux = Infinity;
    let observed_min_y = Infinity;
    let seed_set = new Set();
    let total_markers_unfiltered = 0;
    let zoom_level = 8;

    //Guard clauses
    if (!config_obj || !metadata_obj || !Array.isArray(metadata_obj.points_array)) {
      console.error("[sites_ia_ras.B_discoverActiveTileMask] Invalid configuration or metadata.");
      return null;
    }


    api_base = config_obj.api_base_url.replace(/\/+$/, "");
    grid_size = Number(config_obj.global_grid_tiles_z8) || 128;
    zoom_level = Number(config_obj.zoom_level) || 8;

    for (let i = 0; i < metadata_obj.points_array.length; i++) {
      let local_pt = metadata_obj.points_array[i];
      let local_tile = sites_ia_ras.latLonToTile(local_pt[0], local_pt[1], grid_size);
      if (local_tile)
        seed_set.add(`${local_tile[0]}:${local_tile[1]}`);
    }

    candidate_set = sites_ia_ras.dilateTileSet(seed_set, config_obj.tile_dilation_radius, grid_size);
    candidate_keys_array = Array.from(candidate_set);

    await sites_ia_ras.runPool(candidate_keys_array, config_obj.http_concurrency, async function (arg0_tile_key) {
      let local_parts = arg0_tile_key.split(":");
      let local_tx = Number(local_parts[0]);
      let local_ty = Number(local_parts[1]);
      let local_res = await sites_ia_ras.fetchJson(`${api_base}/rtile/${zoom_level}/${local_tx}/${local_ty}`, config_obj, { agent_obj: agent_obj });
      let local_items = (Array.isArray(local_res) && Array.isArray(local_res[1])) ? local_res[1] : [];

      if (local_items.length > 0) {
        let local_ux = (local_tx < 64) ? local_tx + grid_size : local_tx;
        active_marker_tiles_array.push({
          marker_count: local_items.length,
          tx: local_tx,
          ty: local_ty,
          ux: local_ux
        });
        total_markers_unfiltered += local_items.length;
        observed_min_ux = Math.min(observed_min_ux, local_ux);
        observed_max_ux = Math.max(observed_max_ux, local_ux);
        observed_min_y = Math.min(observed_min_y, local_ty);
        observed_max_y = Math.max(observed_max_y, local_ty);
      }
    });

    active_marker_tiles_array.sort(function (arg0_a, arg1_b) {
      if (arg0_a.ty !== arg1_b.ty) return arg0_a.ty - arg1_b.ty;
      return arg0_a.ux - arg1_b.ux;
    });

    min_unwrapped_x = Math.min(config_obj.mosaic_bounds_z8.min_unwrapped_x, observed_min_ux - 1);
    max_unwrapped_x = Math.max(config_obj.mosaic_bounds_z8.max_unwrapped_x, observed_max_ux + 1);
    min_tile_y = Math.max(0, Math.min(config_obj.mosaic_bounds_z8.min_tile_y, observed_min_y - 1));
    max_tile_y = Math.min(grid_size - 1, Math.max(config_obj.mosaic_bounds_z8.max_tile_y, observed_max_y + 1));

    //Return statement
    return {
      active_marker_tiles_array: active_marker_tiles_array,
      candidate_tiles_scanned: candidate_keys_array.length,
      grid_bounds: {
        height_px: (max_tile_y - min_tile_y + 1)*config_obj.tile_size_px,
        max_tile_y: max_tile_y,
        max_unwrapped_x: max_unwrapped_x,
        min_tile_y: min_tile_y,
        min_unwrapped_x: min_unwrapped_x,
        tile_cols: max_unwrapped_x - min_unwrapped_x + 1,
        tile_rows: max_tile_y - min_tile_y + 1,
        width_px: (max_unwrapped_x - min_unwrapped_x + 1)*config_obj.tile_size_px
      },
      observed_marker_bounds: {
        max_tile_y: observed_max_y,
        max_unwrapped_x: observed_max_ux,
        min_tile_y: observed_min_y,
        min_unwrapped_x: observed_min_ux
      },
      total_markers_unfiltered: total_markers_unfiltered
    };
  };


  /**
   * Step C: Extracts and stitches a complete zoom-8 mosaic PNG for a single chronological period
   * with all site types selected, streaming row bands directly into zlib IDAT chunks.
   * @alias sites_ia_ras.C_extractPeriodMosaic
   *
   * @param {Object} arg0_config_obj - Parsed configuration object.
   * @param {Object} arg1_mask_obj - Output from {@link sites_ia_ras.B_discoverActiveTileMask}.
   * @param {Object} arg2_period_obj - Period entry ({ epoch_id, key, filename, name_en, name_ru }).
   * @param {string} arg3_output_path - Destination path for the stitched mosaic .png.
   * @param {Object} [arg4_options]
   *
   * @returns {Promise<Object>} Extraction statistics for the period mosaic.
   */
  sites_ia_ras.C_extractPeriodMosaic = async function (arg0_config_obj, arg1_mask_obj, arg2_period_obj, arg3_output_path, arg4_options) {
    //Convert from parameters
    let config_obj = arg0_config_obj;
    let mask_obj = arg1_mask_obj;
    let period_obj = arg2_period_obj;
    let output_path = arg3_output_path;
    let options = (arg4_options) ? arg4_options : {};

    //Declare local instance variables
    let agent_obj = options.agent_obj;
    let api_base = "";
    let dilated_period_set = null;
    let epoch_query = "";
    let fetched_png_map = new Map();
    let file_size_bytes = 0;
    let grid_size = 128;
    let grouping_param = "";
    let non_empty_png_tiles = 0;
    let period_marker_count = 0;
    let period_seed_set = new Set();
    let period_site_sum = 0;
    let query_suffix = "";
    let query_tiles_array = [];
    let start_ms = Date.now();
    let zoom_level = 8;

    //Guard clauses
    if (!config_obj || !mask_obj || !period_obj || !output_path) {
      console.error("[sites_ia_ras.C_extractPeriodMosaic] Invalid arguments.");
      return null;
    }


    api_base = config_obj.api_base_url.replace(/\/+$/, "");
    grid_size = Number(config_obj.global_grid_tiles_z8) || 128;
    grouping_param = config_obj.default_grouping ? `g=${encodeURIComponent(config_obj.default_grouping)}` : "";
    zoom_level = Number(config_obj.zoom_level) || 8;

    if (period_obj.epoch_id !== null && period_obj.epoch_id !== undefined)
      epoch_query = `e=${encodeURIComponent(String(period_obj.epoch_id))}`;

    if (epoch_query && grouping_param) {
      query_suffix = `?${epoch_query}&${grouping_param}`;
    } else if (epoch_query) {
      query_suffix = `?${epoch_query}`;
    } else if (grouping_param) {
      query_suffix = `?${grouping_param}`;
    }

    //1. Query rtile JSON across active marker tiles to locate all markers in this period
    await sites_ia_ras.runPool(mask_obj.active_marker_tiles_array, config_obj.http_concurrency, async function (arg0_tile_entry) {
      let local_tx = arg0_tile_entry.tx;
      let local_ty = arg0_tile_entry.ty;
      let local_res = await sites_ia_ras.fetchJson(`${api_base}/rtile/${zoom_level}/${local_tx}/${local_ty}${query_suffix}`, config_obj, { agent_obj: agent_obj });
      let local_items = (Array.isArray(local_res) && Array.isArray(local_res[1])) ? local_res[1] : [];

      if (local_items.length > 0) {
        period_seed_set.add(`${local_tx}:${local_ty}`);
        period_marker_count += local_items.length;
        for (let i = 0; i < local_items.length; i++)
          period_site_sum += Number(local_items[i][8]) || 0;
      }
    });

    //2. Dilate active period tiles by +/-1 neighbour so boundary-crossing circles stitch seamlessly
    dilated_period_set = sites_ia_ras.dilateTileSet(period_seed_set, config_obj.tile_dilation_radius, grid_size);
    query_tiles_array = Array.from(dilated_period_set);

    //3. Fetch raster PNG overlay tiles (rtilee) for all dilated period tiles
    await sites_ia_ras.runPool(query_tiles_array, config_obj.http_concurrency, async function (arg0_tile_key) {
      let local_parts = arg0_tile_key.split(":");
      let local_tx = Number(local_parts[0]);
      let local_ty = Number(local_parts[1]);
      let local_buf = await sites_ia_ras.fetchBuffer(`${api_base}/rtilee/${zoom_level}/${local_tx}/${local_ty}${query_suffix}`, config_obj, { agent_obj: agent_obj });

      if (local_buf && local_buf.length !== config_obj.empty_tile_byte_length) {
        let local_png = pngjs.PNG.sync.read(local_buf);
        fetched_png_map.set(arg0_tile_key, local_png.data);
        non_empty_png_tiles++;
      }
    });

    //4. Stream-encode the full georeferenced RGBA mosaic PNG row-band by row-band
    await sites_ia_ras.writeStreamedMosaicPng(output_path, mask_obj.grid_bounds, fetched_png_map, config_obj);
    file_size_bytes = fs.statSync(output_path).size;

    //Return statement
    return {
      active_marker_tiles: period_seed_set.size,
      dilated_tiles_fetched: query_tiles_array.length,
      elapsed_seconds: Number(((Date.now() - start_ms)/1000).toFixed(2)),
      epoch_id: period_obj.epoch_id,
      file_size_bytes: file_size_bytes,
      filename: period_obj.filename,
      key: period_obj.key,
      marker_clusters_count: period_marker_count,
      name_en: period_obj.name_en,
      name_ru: period_obj.name_ru,
      non_empty_png_tiles: non_empty_png_tiles,
      output_path: output_path,
      site_records_sum: period_site_sum
    };
  };


  /**
   * Step D: Runs the full IA RAS OANMAP zoom-8 extraction pipeline across all configured periods,
   * producing pixel-aligned mosaic PNGs in images/ and a companion georeferencing metadata manifest.
   * @alias sites_ia_ras.D_extractAllPeriodMosaics
   *
   * @param {Object} [arg0_options]
   *
   * @returns {Promise<Object>} Summary manifest written to oanmap_mosaic_metadata.json.
   */
  sites_ia_ras.D_extractAllPeriodMosaics = async function (arg0_options) {
    //Convert from parameters
    let options = (arg0_options) ? arg0_options : {};

    //Declare local instance variables
    let agent_obj = null;
    let all_period_jobs_array = [];
    let all_results_array = [];
    let base_dir = "";
    let config_obj = null;
    let geo_bounds_obj = null;
    let images_dir = "";
    let manifest_obj = null;
    let manifest_path = "";
    let mask_obj = null;
    let metadata_obj = null;

    config_obj = sites_ia_ras.loadConfig(options.config_path);
    if (!config_obj) return null;

    base_dir = (options.base_dir) ? options.base_dir : path.resolve(__dirname);
    images_dir = path.join(base_dir, config_obj.output_images_subfolder || "images");
    manifest_path = path.join(base_dir, config_obj.metadata_filename || "config/oanmap_mosaic_metadata.json");
    if (!fs.existsSync(images_dir)) fs.mkdirSync(images_dir, { recursive: true });
    if (!fs.existsSync(path.dirname(manifest_path))) fs.mkdirSync(path.dirname(manifest_path), { recursive: true });

    agent_obj = new https.Agent({
      keepAlive: true,
      maxSockets: config_obj.http_concurrency || 6
    });

    try {
      console.log("[sites_ia_ras] Step A: Fetching OANMAP dictionaries and regional hierarchy...");
      metadata_obj = await sites_ia_ras.A_fetchMetadata(config_obj, { agent_obj: agent_obj });
      if (!metadata_obj) return null;
      console.log(`[sites_ia_ras] Loaded ${metadata_obj.types_array.length} site types, ${metadata_obj.epochs_array.length} epochs and ${metadata_obj.points_array.length} regional coordinate anchors.`);

      console.log("[sites_ia_ras] Step B: Discovering active zoom-8 marker tiles across Russia...");
      mask_obj = await sites_ia_ras.B_discoverActiveTileMask(config_obj, metadata_obj, { agent_obj: agent_obj });
      if (!mask_obj) return null;
      console.log(`[sites_ia_ras] Active zoom-8 marker tiles: ${mask_obj.active_marker_tiles_array.length} (${mask_obj.total_markers_unfiltered} markers); mosaic canvas: ${mask_obj.grid_bounds.width_px}x${mask_obj.grid_bounds.height_px} px.`);

      for (let i = 0; i < config_obj.periods.length; i++)
        all_period_jobs_array.push(config_obj.periods[i]);

      if (config_obj.include_all_periods_mosaic)
        all_period_jobs_array.unshift({
          epoch_id: null,
          filename: "00_all_periods.png",
          key: "all_periods",
          name_en: "All Periods Combined",
          name_ru: "Все эпохи"
        });

      for (let i = 0; i < all_period_jobs_array.length; i++) {
        let local_job = all_period_jobs_array[i];
        let local_out_path = path.join(images_dir, local_job.filename);
        console.log(`[sites_ia_ras] Step C (${i + 1}/${all_period_jobs_array.length}): Extracting ${local_job.filename} (${local_job.name_en} / ${local_job.name_ru})...`);
        let local_res = await sites_ia_ras.C_extractPeriodMosaic(config_obj, mask_obj, local_job, local_out_path, { agent_obj: agent_obj });
        if (local_res) {
          all_results_array.push(local_res);
          console.log(`[sites_ia_ras]   -> Wrote ${local_res.filename}: ${local_res.marker_clusters_count} clusters, ${local_res.site_records_sum} site records, ${local_res.non_empty_png_tiles} rendered tiles, ${(local_res.file_size_bytes/1048576).toFixed(2)} MB (${local_res.elapsed_seconds}s)`);
        }
      }

      geo_bounds_obj = sites_ia_ras.tileToLatLonBounds(mask_obj.grid_bounds, config_obj.global_grid_tiles_z8);
      manifest_obj = {
        all_site_types_selected: true,
        api_base_url: config_obj.api_base_url,
        crs: "EPSG:3857 (Spherical Web Mercator, continuous unwrapped across 180E antimeridian)",
        extracted_at_utc: new Date().toISOString(),
        georeference: geo_bounds_obj,
        grouping_mode: config_obj.default_grouping,
        mosaic_dimensions: mask_obj.grid_bounds,
        observed_marker_tile_bounds: mask_obj.observed_marker_bounds,
        period_mosaics: all_results_array,
        site_types_dictionary: metadata_obj.types_array,
        source_url: "https://archaeolog.ru/oanmap/",
        tile_size_px: config_obj.tile_size_px,
        zoom_level: config_obj.zoom_level
      };

      fs.writeFileSync(manifest_path, JSON.stringify(manifest_obj, null, 2), "utf8");
      console.log(`[sites_ia_ras] Step D complete. Saved georeference & period manifest to ${manifest_path}`);
    } finally {
      agent_obj.destroy();
    }

    //Return statement
    return manifest_obj;
  };


  /**
   * Dilates a set of "tx:ty" tile keys by a Chebyshev radius in tile space, wrapping X modulo grid_size.
   * @alias sites_ia_ras.dilateTileSet
   *
   * @param {Set<string>} arg0_tile_set - Input set of "tx:ty" strings.
   * @param {number} arg1_radius - Tile dilation radius (e.g. 1 for 3x3 neighbourhood).
   * @param {number} arg2_grid_size - Global tile count per axis (128 at zoom 8 for 512px tiles).
   *
   * @returns {Set<string>} Dilated set of "tx:ty" strings.
   */
  sites_ia_ras.dilateTileSet = function (arg0_tile_set, arg1_radius, arg2_grid_size) {
    //Convert from parameters
    let tile_set = arg0_tile_set;
    let radius = Number(arg1_radius) || 0;
    let grid_size = Number(arg2_grid_size) || 128;

    //Declare local instance variables
    let all_keys_array = [];
    let out_set = new Set();

    //Guard clauses
    if (!tile_set) return out_set;


    all_keys_array = Array.from(tile_set);
    for (let i = 0; i < all_keys_array.length; i++) {
      let local_parts = all_keys_array[i].split(":");
      let local_tx = Number(local_parts[0]);
      let local_ty = Number(local_parts[1]);

      for (let x = -radius; x <= radius; x++) {
        for (let y = -radius; y <= radius; y++) {
          let local_nx = (local_tx + x + grid_size)%grid_size;
          let local_ny = local_ty + y;
          if (local_ny >= 0 && local_ny < grid_size)
            out_set.add(`${local_nx}:${local_ny}`);
        }
      }
    }

    //Return statement
    return out_set;
  };


  /**
   * Fetches a raw binary Buffer over HTTPS with keep-alive pooling and exponential backoff retries.
   * @alias sites_ia_ras.fetchBuffer
   *
   * @param {string} arg0_url - Target HTTPS URL.
   * @param {Object} arg1_config_obj - Configuration with timeout and retry counts.
   * @param {Object} [arg2_options]
   *
   * @returns {Promise<Buffer>} Response payload buffer.
   */
  sites_ia_ras.fetchBuffer = function (arg0_url, arg1_config_obj, arg2_options) {
    //Convert from parameters
    let url = arg0_url;
    let config_obj = (arg1_config_obj) ? arg1_config_obj : {};
    let options = (arg2_options) ? arg2_options : {};

    //Declare local instance variables
    let max_retries = (config_obj.http_retries !== undefined) ? Number(config_obj.http_retries) : 4;
    let timeout_ms = (config_obj.http_timeout_ms !== undefined) ? Number(config_obj.http_timeout_ms) : 20000;

    //Guard clauses
    if (!url) {
      console.error("[sites_ia_ras.fetchBuffer] Empty URL.");
      return Promise.resolve(null);
    }


    //Return statement
    return new Promise(function (resolve) {
      let attemptRequest = function (arg0_retries_left) {
        let local_retries = arg0_retries_left;
        let local_req = https.get(url, {
          agent: options.agent_obj,
          headers: {
            "Accept": "*/*",
            "Referer": "https://archaeolog.ru/oanmap/",
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0.0.0 Safari/537.36"
          },
          timeout: timeout_ms
        }, function (res) {
          let local_chunks_array = [];

          if (res.statusCode !== 200) {
            res.resume();
            if (local_retries > 0) {
              let local_delay = (max_retries - local_retries + 1)*600;
              setTimeout(() => attemptRequest(local_retries - 1), local_delay);
              return;
            }
            console.error(`[sites_ia_ras.fetchBuffer] HTTP ${res.statusCode} on ${url}`);
            resolve(null);
            return;
          }

          res.on("data", function (chunk) {
            local_chunks_array.push(chunk);
          });
          res.on("end", function () {
            resolve(Buffer.concat(local_chunks_array));
          });
        });

        local_req.on("timeout", function () {
          local_req.destroy(new Error("Request timeout"));
        });

        local_req.on("error", function (err) {
          if (local_retries > 0) {
            let local_delay = (max_retries - local_retries + 1)*600;
            setTimeout(() => attemptRequest(local_retries - 1), local_delay);
            return;
          }
          console.error(`[sites_ia_ras.fetchBuffer] Network error on ${url}:`, err.message);
          resolve(null);
        });
      };

      attemptRequest(max_retries);
    });
  };


  /**
   * Fetches and parses a JSON endpoint from the OANMAP API.
   * @alias sites_ia_ras.fetchJson
   *
   * @param {string} arg0_url - Target HTTPS URL.
   * @param {Object} arg1_config_obj - Configuration object.
   * @param {Object} [arg2_options]
   *
   * @returns {Promise<*>} Parsed JSON payload, or null on failure.
   */
  sites_ia_ras.fetchJson = async function (arg0_url, arg1_config_obj, arg2_options) {
    //Convert from parameters
    let url = arg0_url;
    let config_obj = arg1_config_obj;
    let options = (arg2_options) ? arg2_options : {};

    //Declare local instance variables
    let raw_buf = null;

    raw_buf = await sites_ia_ras.fetchBuffer(url, config_obj, options);
    if (!raw_buf) return null;

    try {
      //Return statement
      return JSON.parse(raw_buf.toString("utf8"));
    } catch (e) {
      console.error(`[sites_ia_ras.fetchJson] Invalid JSON from ${url}:`, e.message);
      return null;
    }
  };


  /**
   * Projects WGS84 [lat, lon] degrees into OANMAP Spherical Mercator tile indices [tx, ty].
   * Matches the Gn() projection function in OANMAP's LegacyMapView bundle.
   * @alias sites_ia_ras.latLonToTile
   *
   * @param {number} arg0_lat - Latitude in degrees.
   * @param {number} arg1_lon - Longitude in degrees.
   * @param {number} arg2_grid_size - Number of tiles per world axis (128 at zoom 8 for 512px tiles).
   *
   * @returns {number[]|null} [tx, ty] integer tile indices.
   */
  sites_ia_ras.latLonToTile = function (arg0_lat, arg1_lon, arg2_grid_size) {
    //Convert from parameters
    let lat = Number(arg0_lat);
    let lon = Number(arg1_lon);
    let grid_size = Number(arg2_grid_size) || 128;

    //Declare local instance variables
    let clamped_lat = 0;
    let raw_x = 0;
    let raw_y = 0;
    let tx = 0;
    let ty = 0;

    //Guard clauses
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;


    raw_x = ((lon/180 + 1)/2*grid_size + grid_size)%grid_size;
    tx = Math.trunc(raw_x);
    clamped_lat = Math.min(90 - 1e-14, Math.max(-(90 - 1e-14), lat));
    raw_y = (1 - Math.log(Math.tan((90 + clamped_lat)*Math.PI/360))/Math.PI)/2*grid_size;
    ty = Math.max(0, Math.min(grid_size - 1, Math.trunc(raw_y)));

    //Return statement
    return [tx, ty];
  };


  /**
   * Loads the JSON5 configuration file from histmap/1.data_raw/sites_IA_RAS/config/sites_ia_ras.json5.
   * @alias sites_ia_ras.loadConfig
   *
   * @param {string} [arg0_config_path] - Optional explicit path to JSON5 configuration file.
   *
   * @returns {Object|null} Parsed configuration object.
   */
  sites_ia_ras.loadConfig = function (arg0_config_path) {
    //Convert from parameters
    let config_path = arg0_config_path;

    //Declare local instance variables
    let default_path = path.resolve(__dirname, "config/sites_ia_ras.json5");
    let resolved_path = (config_path) ? path.resolve(config_path) : default_path;

    //Guard clauses
    if (!fs.existsSync(resolved_path)) {
      console.error(`[sites_ia_ras.loadConfig] Config file not found at ${resolved_path}`);
      return null;
    }


    //Return statement
    return JSON5.parse(fs.readFileSync(resolved_path, "utf8"));
  };


  /**
   * Executes an asynchronous callback across an array of items with bounded concurrency.
   * @alias sites_ia_ras.runPool
   *
   * @param {Array<*>} arg0_items_array - Work items to process.
   * @param {number} arg1_concurrency - Maximum concurrent tasks.
   * @param {Function} arg2_worker_fn - Async callback receiving (item, index).
   *
   * @returns {Promise<void>}
   */
  sites_ia_ras.runPool = async function (arg0_items_array, arg1_concurrency, arg2_worker_fn) {
    //Convert from parameters
    let items_array = (Array.isArray(arg0_items_array)) ? arg0_items_array : [];
    let concurrency = Math.max(1, Number(arg1_concurrency) || 6);
    let worker_fn = arg2_worker_fn;

    //Declare local instance variables
    let cursor_obj = { index: 0 };
    let worker_count = Math.min(concurrency, items_array.length);
    let workers_array = [];

    //Guard clauses
    if (items_array.length === 0 || typeof worker_fn !== "function") return;


    for (let i = 0; i < worker_count; i++) {
      workers_array.push((async function () {
        for (let x = 0; x < items_array.length; x++) {
          let local_idx = cursor_obj.index;
          if (local_idx >= items_array.length) break;
          cursor_obj.index = local_idx + 1;
          await worker_fn(items_array[local_idx], local_idx);
        }
      })());
    }

    await Promise.all(workers_array);
  };


  /**
   * Computes exact EPSG:3857 Web Mercator metre bounds and WGS84 degree bounds
   * for the stitched mosaic tile grid, plus pixel-to-coordinate conversion constants.
   * @alias sites_ia_ras.tileToLatLonBounds
   *
   * @param {Object} arg0_grid_bounds - Grid bounds object from {@link sites_ia_ras.B_discoverActiveTileMask}.
   * @param {number} arg1_grid_size - Global tile count per axis (128 at zoom 8 for 512px tiles).
   *
   * @returns {Object} Georeferencing bounds and affine pixel origin parameters.
   */
  sites_ia_ras.tileToLatLonBounds = function (arg0_grid_bounds, arg1_grid_size) {
    //Convert from parameters
    let grid_bounds = arg0_grid_bounds;
    let grid_size = Number(arg1_grid_size) || 128;

    //Declare local instance variables
    let earth_half_circ_m = Math.PI*6378137.0;
    let global_px_size = grid_size*512;
    let lat_north = 0;
    let lat_south = 0;
    let lon_east_unwrapped = 0;
    let lon_west_unwrapped = 0;
    let mercator_x_max = 0;
    let mercator_x_min = 0;
    let mercator_y_max = 0;
    let mercator_y_min = 0;

    //Guard clauses
    if (!grid_bounds) return null;


    lon_west_unwrapped = (grid_bounds.min_unwrapped_x/grid_size)*360.0 - 180.0;
    lon_east_unwrapped = ((grid_bounds.max_unwrapped_x + 1)/grid_size)*360.0 - 180.0;
    lat_north = (360.0/Math.PI)*Math.atan(Math.exp(Math.PI*(1.0 - 2.0*(grid_bounds.min_tile_y/grid_size)))) - 90.0;
    lat_south = (360.0/Math.PI)*Math.atan(Math.exp(Math.PI*(1.0 - 2.0*((grid_bounds.max_tile_y + 1)/grid_size)))) - 90.0;

    mercator_x_min = ((grid_bounds.min_unwrapped_x/grid_size)*2.0 - 1.0)*earth_half_circ_m;
    mercator_x_max = (((grid_bounds.max_unwrapped_x + 1)/grid_size)*2.0 - 1.0)*earth_half_circ_m;
    mercator_y_max = (1.0 - (grid_bounds.min_tile_y/grid_size)*2.0)*earth_half_circ_m;
    mercator_y_min = (1.0 - ((grid_bounds.max_tile_y + 1)/grid_size)*2.0)*earth_half_circ_m;

    //Return statement
    return {
      epsg_3857_meters: {
        pixel_size_m: (2.0*earth_half_circ_m)/global_px_size,
        x_max: mercator_x_max,
        x_min: mercator_x_min,
        y_max: mercator_y_max,
        y_min: mercator_y_min
      },
      global_web_mercator_px: {
        global_size_px: global_px_size,
        origin_global_px_x: grid_bounds.min_unwrapped_x*512,
        origin_global_px_y: grid_bounds.min_tile_y*512
      },
      wgs84_degrees: {
        lat_north: lat_north,
        lat_south: lat_south,
        lon_east_unwrapped: lon_east_unwrapped,
        lon_east_wrapped: ((lon_east_unwrapped + 180.0)%360.0 + 360.0)%360.0 - 180.0,
        lon_west: lon_west_unwrapped
      }
    };
  };


  /**
   * Writes a single spec-compliant PNG chunk (length + ASCII type + payload + IEEE CRC-32) to a file descriptor.
   * @alias sites_ia_ras.writePngChunk
   *
   * @param {number} arg0_fd - Open writable file descriptor.
   * @param {string} arg1_chunk_type - 4-character ASCII PNG chunk type ('IHDR', 'IDAT', 'IEND').
   * @param {Buffer} arg2_data_buf - Chunk payload buffer.
   */
  sites_ia_ras.writePngChunk = function (arg0_fd, arg1_chunk_type, arg2_data_buf) {
    //Convert from parameters
    let fd = arg0_fd;
    let chunk_type = arg1_chunk_type;
    let data_buf = arg2_data_buf;

    //Declare local instance variables
    let crc_val = 0;
    let footer_buf = Buffer.alloc(4);
    let header_buf = Buffer.alloc(8);

    header_buf.writeUInt32BE(data_buf.length, 0);
    header_buf.write(chunk_type, 4, 4, "ascii");
    crc_val = zlib.crc32(header_buf.subarray(4, 8));
    if (data_buf.length > 0) crc_val = zlib.crc32(data_buf, crc_val);
    footer_buf.writeUInt32BE(crc_val >>> 0, 0);

    fs.writeSync(fd, header_buf);
    if (data_buf.length > 0) fs.writeSync(fd, data_buf);
    fs.writeSync(fd, footer_buf);
  };


  /**
   * Streams a full zoom-8 RGBA mosaic PNG to disk one 512-pixel tile-row band at a time,
   * keeping memory usage around ~65 MB regardless of total mosaic width and height.
   * @alias sites_ia_ras.writeStreamedMosaicPng
   *
   * @param {string} arg0_output_path - Output .png file path.
   * @param {Object} arg1_grid_bounds - Mosaic grid dimensions and tile indices.
   * @param {Map<string, Buffer>} arg2_tile_rgba_map - Map of "tx:ty" -> 512x512 RGBA Buffer.
   * @param {Object} arg3_config_obj - Configuration object.
   *
   * @returns {Promise<void>}
   */
  sites_ia_ras.writeStreamedMosaicPng = async function (arg0_output_path, arg1_grid_bounds, arg2_tile_rgba_map, arg3_config_obj) {
    //Convert from parameters
    let output_path = arg0_output_path;
    let grid_bounds = arg1_grid_bounds;
    let tile_rgba_map = arg2_tile_rgba_map;
    let config_obj = (arg3_config_obj) ? arg3_config_obj : {};

    //Declare local instance variables
    let band_buf = null;
    let compression_level = (config_obj.png_compression_level !== undefined) ? Number(config_obj.png_compression_level) : 6;
    let deflate_stream = null;
    let done_promise = null;
    let fd = 0;
    let grid_size = Number(config_obj.global_grid_tiles_z8) || 128;
    let height_px = grid_bounds.height_px;
    let ihdr_buf = Buffer.alloc(13);
    let png_signature = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
    let row_stride = 0;
    let tile_px = Number(config_obj.tile_size_px) || 512;
    let tile_row_bytes = 0;
    let width_px = grid_bounds.width_px;

    fd = fs.openSync(output_path, "w");
    try {
      fs.writeSync(fd, png_signature);

      ihdr_buf.writeUInt32BE(width_px, 0);
      ihdr_buf.writeUInt32BE(height_px, 4);
      ihdr_buf[8] = 8; //8-bit per channel
      ihdr_buf[9] = 6; //Truecolour with alpha (RGBA)
      ihdr_buf[10] = 0; //Deflate compression
      ihdr_buf[11] = 0; //Adaptive filtering
      ihdr_buf[12] = 0; //Non-interlaced
      sites_ia_ras.writePngChunk(fd, "IHDR", ihdr_buf);

      deflate_stream = zlib.createDeflate({
        chunkSize: 1024*1024,
        level: compression_level
      });
      deflate_stream.on("data", function (chunk) {
        sites_ia_ras.writePngChunk(fd, "IDAT", chunk);
      });
      done_promise = new Promise(function (resolve, reject) {
        deflate_stream.on("end", resolve);
        deflate_stream.on("error", reject);
      });

      row_stride = 1 + width_px*4;
      tile_row_bytes = tile_px*4;
      band_buf = Buffer.alloc(tile_px*row_stride);

      for (let i = grid_bounds.min_tile_y; i <= grid_bounds.max_tile_y; i++) {
        band_buf.fill(0);

        for (let x = grid_bounds.min_unwrapped_x; x <= grid_bounds.max_unwrapped_x; x++) {
          let local_tx = (x%grid_size + grid_size)%grid_size;
          let local_tile_data = tile_rgba_map.get(`${local_tx}:${i}`);

          if (local_tile_data) {
            let local_col_index = x - grid_bounds.min_unwrapped_x;
            let local_dest_col_offset = 1 + local_col_index*tile_row_bytes;

            for (let y = 0; y < tile_px; y++) {
              let local_src_offset = y*tile_row_bytes;
              local_tile_data.copy(
                band_buf,
                y*row_stride + local_dest_col_offset,
                local_src_offset,
                local_src_offset + tile_row_bytes
              );
            }
          }
        }

        let local_can_continue = deflate_stream.write(band_buf);
        if (!local_can_continue)
          await new Promise((resolve) => deflate_stream.once("drain", resolve));
      }

      deflate_stream.end();
      await done_promise;
      sites_ia_ras.writePngChunk(fd, "IEND", Buffer.alloc(0));
    } finally {
      fs.closeSync(fd);
    }
  };
}


//CLI entrypoint when executed directly via Node.js
if (typeof require !== "undefined" && require.main === module) {
  sites_ia_ras.D_extractAllPeriodMosaics().then(function (arg0_manifest) {
    if (!arg0_manifest) {
      process.exitCode = 1;
      return;
    }
    console.log(`[sites_ia_ras] Successfully generated ${arg0_manifest.period_mosaics.length} period mosaics.`);
  });
}

