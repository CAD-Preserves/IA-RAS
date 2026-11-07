//Import libraries
let fs = (global.fs) ? global.fs : require("fs");
let https = require("https");
let JSON5 = (global.JSON5) ? global.JSON5 : require("json5");
let path = (global.path) ? global.path : require("path");


//Initialise functions
{
  if (!global.sites_ia_ras_geojson) global.sites_ia_ras_geojson = {};

  /**
   * Step A: Fetches OANMAP site-type and epoch dictionaries from /api/map/dicts?regs.
   * @alias sites_ia_ras_geojson.A_fetchDictionaries
   *
   * @param {Object} arg0_config_obj - Parsed configuration object from config/sites_ia_ras.json5.
   * @param {Object} [arg1_options]
   *
   * @returns {Promise<Object|null>} Parsed site-type and epoch lookup maps.
   */
  sites_ia_ras_geojson.A_fetchDictionaries = async function (arg0_config_obj, arg1_options) {
    //Convert from parameters
    let config_obj = arg0_config_obj;
    let options = (arg1_options) ? arg1_options : {};

    //Declare local instance variables
    let agent_obj = options.agent_obj;
    let all_epochs_map = {};
    let all_types_array = [];
    let all_types_map = {};
    let api_base = "";
    let dicts_raw = null;

    //Guard clauses
    if (!config_obj || !config_obj.api_base_url) {
      console.error("[sites_ia_ras_geojson.A_fetchDictionaries] Missing config_obj.api_base_url.");
      return null;
    }


    api_base = config_obj.api_base_url.replace(/\/+$/, "");
    dicts_raw = await sites_ia_ras_geojson.fetchJson(`${api_base}/dicts?regs`, config_obj, { agent_obj: agent_obj });
    if (!Array.isArray(dicts_raw)) {
      console.error("[sites_ia_ras_geojson.A_fetchDictionaries] Unexpected /dicts?regs response.");
      return null;
    }

    if (Array.isArray(dicts_raw[1])) {
      for (let i = 0; i < dicts_raw[1].length; i++) {
        let local_entry = dicts_raw[1][i];
        if (Array.isArray(local_entry) && local_entry.length >= 2) {
          let local_id = Number(local_entry[0]);
          let local_name = String(local_entry[1]).trim();
          all_types_map[local_id] = local_name;
          all_types_array.push({
            colour_hex: local_entry[5] ? String(local_entry[5]) : null,
            id: local_id,
            name_ru: local_name
          });
        }
      }
    }

    if (Array.isArray(dicts_raw[2])) {
      for (let i = 0; i < dicts_raw[2].length; i++) {
        let local_entry = dicts_raw[2][i];
        if (Array.isArray(local_entry) && local_entry.length >= 2)
          all_epochs_map[Number(local_entry[0])] = String(local_entry[1]).trim();
      }
    }
    all_epochs_map[-1] = "Не указано";

    //Return statement
    return {
      epochs_map: all_epochs_map,
      types_array: all_types_array,
      types_map: all_types_map
    };
  };


  /**
   * Step B: Crawls the complete all-Russia OANMAP regional tree (Federal Districts -> Oblasts ->
   * Raions/Cities/Settlements and any deeper leaf nodes) via /api/map/reg, verifying conservation
   * of per-epoch counts between parents and children so zero sites are omitted or double-counted.
   * @alias sites_ia_ras_geojson.B_crawlRegionalHierarchy
   *
   * @param {Object} arg0_config_obj - Parsed configuration object.
   * @param {Object} [arg1_options]
   *
   * @returns {Promise<Object|null>} Complete array of leaf point records covering all of Russia.
   */
  sites_ia_ras_geojson.B_crawlRegionalHierarchy = async function (arg0_config_obj, arg1_options) {
    //Convert from parameters
    let config_obj = arg0_config_obj;
    let options = (arg1_options) ? arg1_options : {};

    //Declare local instance variables
    let agent_obj = options.agent_obj;
    let all_fd_nodes_array = [];
    let all_leaf_records_array = [];
    let all_oblast_tasks_array = [];
    let api_base = "";
    let federal_districts_raw = [];
    let residual_nodes_count = 0;
    let visited_ids_set = new Set();
    let z2_raw = null;

    //Guard clauses
    if (!config_obj || !config_obj.api_base_url) {
      console.error("[sites_ia_ras_geojson.B_crawlRegionalHierarchy] Missing config_obj.api_base_url.");
      return null;
    }


    api_base = config_obj.api_base_url.replace(/\/+$/, "");
    z2_raw = await sites_ia_ras_geojson.fetchJson(`${api_base}/rtile/2/1/0`, config_obj, { agent_obj: agent_obj });
    federal_districts_raw = (Array.isArray(z2_raw) && Array.isArray(z2_raw[1])) ? z2_raw[1] : [];

    //1. Fetch all 8 Federal Districts
    for (let i = 0; i < federal_districts_raw.length; i++) {
      let local_fd_tuple = federal_districts_raw[i];
      let local_fd_id = Number(local_fd_tuple[0]);
      let local_fd_res = await sites_ia_ras_geojson.fetchJson(`${api_base}/reg?r=${local_fd_id}`, config_obj, { agent_obj: agent_obj });
      let local_fd_parsed = sites_ia_ras_geojson.parseRegPayload(local_fd_res);

      if (local_fd_parsed) {
        visited_ids_set.add(local_fd_parsed.region_id);
        all_fd_nodes_array.push(local_fd_parsed);

        for (let x = 0; x < local_fd_parsed.children_stubs_array.length; x++) {
          let local_ch = local_fd_parsed.children_stubs_array[x];
          if (!visited_ids_set.has(local_ch.region_id)) {
            visited_ids_set.add(local_ch.region_id);
            all_oblast_tasks_array.push({
              fd_id: local_fd_parsed.region_id,
              fd_name_ru: local_fd_parsed.name_ru,
              region_id: local_ch.region_id
            });
          }
        }
      }
    }

    //2. Fetch all Oblasts / Federal Subjects in parallel
    let all_oblast_nodes_map = new Map();
    let all_subregion_tasks_array = [];

    await sites_ia_ras_geojson.runPool(all_oblast_tasks_array, config_obj.http_concurrency, async function (arg0_task) {
      let local_task = arg0_task;
      let local_res = await sites_ia_ras_geojson.fetchJson(`${api_base}/reg?r=${local_task.region_id}`, config_obj, { agent_obj: agent_obj });
      let local_parsed = sites_ia_ras_geojson.parseRegPayload(local_res);
      if (!local_parsed) return;

      local_parsed.federal_district_id = local_task.fd_id;
      local_parsed.federal_district_name_ru = local_task.fd_name_ru;
      local_parsed.oblast_id = local_parsed.region_id;
      local_parsed.oblast_name_ru = local_parsed.name_ru;
      all_oblast_nodes_map.set(local_parsed.region_id, local_parsed);

      if (local_parsed.children_stubs_array.length === 0) {
        all_leaf_records_array.push(local_parsed);
      } else {
        for (let i = 0; i < local_parsed.children_stubs_array.length; i++) {
          let local_ch = local_parsed.children_stubs_array[i];
          if (!visited_ids_set.has(local_ch.region_id)) {
            visited_ids_set.add(local_ch.region_id);
            all_subregion_tasks_array.push({
              fd_id: local_task.fd_id,
              fd_name_ru: local_task.fd_name_ru,
              oblast_id: local_parsed.region_id,
              oblast_name_ru: local_parsed.name_ru,
              parent_id: local_parsed.region_id,
              region_id: local_ch.region_id
            });
          }
        }
      }
    });

    //3. Fetch all Level-3 Raions / Cities / Settlements (and any deeper Level-4+ children recursively up to 4 levels)
    let current_wave_array = all_subregion_tasks_array;
    let parent_children_map = new Map();

    for (let i = 0; i < 4; i++) {
      if (current_wave_array.length === 0) break;
      let local_next_wave_array = [];

      await sites_ia_ras_geojson.runPool(current_wave_array, config_obj.http_concurrency, async function (arg0_task) {
        let local_task = arg0_task;
        let local_res = await sites_ia_ras_geojson.fetchJson(`${api_base}/reg?r=${local_task.region_id}`, config_obj, { agent_obj: agent_obj });
        let local_parsed = sites_ia_ras_geojson.parseRegPayload(local_res);
        if (!local_parsed) return;

        local_parsed.federal_district_id = local_task.fd_id;
        local_parsed.federal_district_name_ru = local_task.fd_name_ru;
        local_parsed.oblast_id = local_task.oblast_id;
        local_parsed.oblast_name_ru = local_task.oblast_name_ru;

        if (!parent_children_map.has(local_task.parent_id))
          parent_children_map.set(local_task.parent_id, []);
        parent_children_map.get(local_task.parent_id).push(local_parsed);

        if (local_parsed.children_stubs_array.length === 0) {
          all_leaf_records_array.push(local_parsed);
        } else {
          all_oblast_nodes_map.set(local_parsed.region_id, local_parsed);
          for (let x = 0; x < local_parsed.children_stubs_array.length; x++) {
            let local_ch = local_parsed.children_stubs_array[x];
            if (!visited_ids_set.has(local_ch.region_id)) {
              visited_ids_set.add(local_ch.region_id);
              local_next_wave_array.push({
                fd_id: local_task.fd_id,
                fd_name_ru: local_task.fd_name_ru,
                oblast_id: local_task.oblast_id,
                oblast_name_ru: local_task.oblast_name_ru,
                parent_id: local_parsed.region_id,
                region_id: local_ch.region_id
              });
            }
          }
        }
      });

      current_wave_array = local_next_wave_array;
    }

    //4. Verify parent vs children epoch sums so any unallocated parent-level sites are preserved as residual points
    let all_parents_array = Array.from(all_oblast_nodes_map.values());
    for (let i = 0; i < all_parents_array.length; i++) {
      let local_parent = all_parents_array[i];
      let local_children = parent_children_map.get(local_parent.region_id) || [];
      let local_child_epoch_sums = {};
      let local_has_residual = false;
      let local_parent_epoch_keys = Object.keys(local_parent.counts_by_epoch);
      let local_residual_epochs = {};
      let local_residual_total = 0;

      for (let x = 0; x < local_children.length; x++) {
        let local_c_epochs = local_children[x].counts_by_epoch;
        let local_c_keys = Object.keys(local_c_epochs);
        for (let y = 0; y < local_c_keys.length; y++) {
          let local_k = local_c_keys[y];
          local_child_epoch_sums[local_k] = (local_child_epoch_sums[local_k] || 0) + Number(local_c_epochs[local_k]);
        }
      }

      for (let x = 0; x < local_parent_epoch_keys.length; x++) {
        let local_k = local_parent_epoch_keys[x];
        let local_diff = (Number(local_parent.counts_by_epoch[local_k]) || 0) - (local_child_epoch_sums[local_k] || 0);
        if (local_diff > 0) {
          local_residual_epochs[local_k] = local_diff;
          local_residual_total += local_diff;
          local_has_residual = true;
        }
      }

      if (local_has_residual && local_parent.lat !== null && local_parent.lon !== null) {
        residual_nodes_count++;
        all_leaf_records_array.push({
          admin_level: local_parent.admin_level,
          bbox_wgs84: local_parent.bbox_wgs84,
          children_stubs_array: [],
          counts_by_epoch: local_residual_epochs,
          counts_by_type: {},
          federal_district_id: local_parent.federal_district_id,
          federal_district_name_ru: local_parent.federal_district_name_ru,
          is_residual_parent: true,
          is_unspecified_subregion: true,
          lat: local_parent.lat,
          lon: local_parent.lon,
          name_ru: `${local_parent.name_ru} (без уточнения района)`,
          oblast_id: local_parent.oblast_id,
          oblast_name_ru: local_parent.oblast_name_ru,
          region_id: local_parent.region_id,
          total_sites_all_periods: local_residual_total
        });
      }
    }

    all_leaf_records_array.sort(function (arg0_a, arg1_b) {
      if (arg0_a.federal_district_id !== arg1_b.federal_district_id)
        return arg0_a.federal_district_id - arg1_b.federal_district_id;
      if (arg0_a.oblast_id !== arg1_b.oblast_id)
        return arg0_a.oblast_id - arg1_b.oblast_id;
      return arg0_a.region_id - arg1_b.region_id;
    });

    //Return statement
    return {
      federal_districts_count: all_fd_nodes_array.length,
      leaf_records_array: all_leaf_records_array,
      oblasts_count: all_oblast_tasks_array.length,
      residual_nodes_count: residual_nodes_count,
      total_nodes_queried: visited_ids_set.size
    };
  };


  /**
   * Step C: Builds an RFC 7946 all-Russia GeoJSON FeatureCollection for a single chronological period
   * (or across all periods when epoch_id is null) and writes it to disk.
   * @alias sites_ia_ras_geojson.C_buildPeriodGeoJson
   *
   * @param {Array<Object>} arg0_leaf_records_array - All-Russia leaf records from {@link sites_ia_ras_geojson.B_crawlRegionalHierarchy}.
   * @param {Object} arg1_dicts_obj - Dictionary maps from {@link sites_ia_ras_geojson.A_fetchDictionaries}.
   * @param {Object} arg2_period_obj - Period definition from config/sites_ia_ras.json5.
   * @param {string} arg3_output_path - Destination .geojson file path.
   *
   * @returns {Object|null} Summary metrics for the generated GeoJSON file.
   */
  sites_ia_ras_geojson.C_buildPeriodGeoJson = function (arg0_leaf_records_array, arg1_dicts_obj, arg2_period_obj, arg3_output_path) {
    //Convert from parameters
    let leaf_records_array = arg0_leaf_records_array;
    let dicts_obj = arg1_dicts_obj;
    let period_obj = arg2_period_obj;
    let output_path = arg3_output_path;

    //Declare local instance variables
    let epoch_key = "";
    let features_array = [];
    let file_size_bytes = 0;
    let geojson_obj = null;
    let is_all_periods = false;
    let oblasts_present_set = new Set();
    let total_sites_in_period = 0;

    //Guard clauses
    if (!Array.isArray(leaf_records_array) || !period_obj || !output_path) {
      console.error("[sites_ia_ras_geojson.C_buildPeriodGeoJson] Invalid parameters.");
      return null;
    }


    is_all_periods = (period_obj.epoch_id === null || period_obj.epoch_id === undefined);
    epoch_key = (!is_all_periods) ? String(period_obj.epoch_id) : "all";

    for (let i = 0; i < leaf_records_array.length; i++) {
      let local_rec = leaf_records_array[i];
      if (local_rec.lat === null || local_rec.lon === null) continue;

      let local_count = (is_all_periods)
        ? Number(local_rec.total_sites_all_periods) || 0
        : Number(local_rec.counts_by_epoch[epoch_key]) || 0;

      if (local_count <= 0) continue;

      let local_lon_u = (local_rec.lon < 0) ? local_rec.lon + 360.0 : local_rec.lon;
      let local_named_types_obj = {};
      let local_type_keys = Object.keys(local_rec.counts_by_type || {});

      for (let x = 0; x < local_type_keys.length; x++) {
        let local_tid = local_type_keys[x];
        let local_tname = (dicts_obj && dicts_obj.types_map && dicts_obj.types_map[local_tid])
          ? dicts_obj.types_map[local_tid]
          : `type_${local_tid}`;
        local_named_types_obj[local_tname] = Number(local_rec.counts_by_type[local_tid]);
      }

      oblasts_present_set.add(local_rec.oblast_id);
      total_sites_in_period += local_count;

      features_array.push({
        type: "Feature",
        geometry: {
          type: "Point",
          coordinates: [local_rec.lon, local_rec.lat]
        },
        properties: {
          admin_level: local_rec.admin_level,
          all_periods_counts_by_type_ru: local_named_types_obj,
          bbox_wgs84: local_rec.bbox_wgs84,
          epoch_id: period_obj.epoch_id,
          federal_district_id: local_rec.federal_district_id,
          federal_district_name_ru: local_rec.federal_district_name_ru,
          is_unspecified_subregion: local_rec.is_unspecified_subregion,
          lon_unwrapped: Number(local_lon_u.toFixed(6)),
          name_ru: local_rec.name_ru,
          oblast_id: local_rec.oblast_id,
          oblast_name_ru: local_rec.oblast_name_ru,
          period_key: period_obj.key,
          period_name_en: period_obj.name_en,
          period_name_ru: period_obj.name_ru,
          region_id: local_rec.region_id,
          site_count: local_count,
          total_sites_all_periods: local_rec.total_sites_all_periods,
          unspecified_period_sites: Number(local_rec.counts_by_epoch["-1"]) || 0
        }
      });
    }

    geojson_obj = {
      type: "FeatureCollection",
      name: `sites_ia_ras_${period_obj.key}`,
      metadata: {
        all_site_types_selected: true,
        crs: "EPSG:4326 (WGS84 [longitude, latitude])",
        epoch_id: period_obj.epoch_id,
        extracted_at_utc: new Date().toISOString(),
        feature_count: features_array.length,
        oblasts_with_sites_count: oblasts_present_set.size,
        period_key: period_obj.key,
        period_name_en: period_obj.name_en,
        period_name_ru: period_obj.name_ru,
        source_url: "https://archaeolog.ru/oanmap/",
        total_sites_count: total_sites_in_period
      },
      features: features_array
    };

    fs.writeFileSync(output_path, JSON.stringify(geojson_obj, null, 2), "utf8");
    file_size_bytes = fs.statSync(output_path).size;

    //Return statement
    return {
      epoch_id: period_obj.epoch_id,
      feature_count: features_array.length,
      file_size_bytes: file_size_bytes,
      filename: path.basename(output_path),
      key: period_obj.key,
      name_en: period_obj.name_en,
      name_ru: period_obj.name_ru,
      oblasts_with_sites_count: oblasts_present_set.size,
      output_path: output_path,
      total_sites_count: total_sites_in_period
    };
  };


  /**
   * Step D: Runs the complete all-Russia OANMAP regional JSON crawl and writes one all-Russia
   * GeoJSON file per chronological period into histmap/1.data_raw/sites_IA_RAS/geojson/.
   * @alias sites_ia_ras_geojson.D_extractAllPeriodGeoJsons
   *
   * @param {Object} [arg0_options]
   *
   * @returns {Promise<Object|null>} Summary metadata written to config/oanmap_geojson_metadata.json.
   */
  sites_ia_ras_geojson.D_extractAllPeriodGeoJsons = async function (arg0_options) {
    //Convert from parameters
    let options = (arg0_options) ? arg0_options : {};

    //Declare local instance variables
    let agent_obj = null;
    let all_jobs_array = [];
    let all_results_array = [];
    let base_dir = "";
    let config_obj = null;
    let crawl_obj = null;
    let dicts_obj = null;
    let geojson_dir = "";
    let start_ms = Date.now();
    let summary_obj = null;
    let summary_path = "";

    config_obj = sites_ia_ras_geojson.loadConfig(options.config_path);
    if (!config_obj) return null;

    base_dir = (options.base_dir) ? options.base_dir : path.resolve(__dirname);
    geojson_dir = path.join(base_dir, config_obj.output_geojson_subfolder || "geojson");
    summary_path = path.join(base_dir, config_obj.geojson_metadata_filename || "config/oanmap_geojson_metadata.json");

    if (!fs.existsSync(geojson_dir)) fs.mkdirSync(geojson_dir, { recursive: true });
    if (!fs.existsSync(path.dirname(summary_path))) fs.mkdirSync(path.dirname(summary_path), { recursive: true });

    agent_obj = new https.Agent({
      keepAlive: true,
      maxSockets: config_obj.http_concurrency || 6
    });

    try {
      console.log("[sites_ia_ras_geojson] Step A: Fetching OANMAP dictionaries...");
      dicts_obj = await sites_ia_ras_geojson.A_fetchDictionaries(config_obj, { agent_obj: agent_obj });
      if (!dicts_obj) return null;

      console.log("[sites_ia_ras_geojson] Step B: Crawling all-Russia regional hierarchy (Federal Districts -> Oblasts -> Raions/Cities)...");
      crawl_obj = await sites_ia_ras_geojson.B_crawlRegionalHierarchy(config_obj, { agent_obj: agent_obj });
      if (!crawl_obj) return null;
      console.log(`[sites_ia_ras_geojson] Crawled ${crawl_obj.total_nodes_queried} regional nodes -> ${crawl_obj.leaf_records_array.length} leaf point locations (${crawl_obj.residual_nodes_count} residual parent points) in ${((Date.now() - start_ms)/1000).toFixed(2)}s.`);

      for (let i = 0; i < config_obj.periods.length; i++)
        all_jobs_array.push(config_obj.periods[i]);

      if (config_obj.include_all_periods_geojson)
        all_jobs_array.unshift({
          epoch_id: null,
          geojson_filename: "00_all_periods.geojson",
          key: "all_periods",
          name_en: "All Periods Combined",
          name_ru: "Все эпохи"
        });

      for (let i = 0; i < all_jobs_array.length; i++) {
        let local_job = all_jobs_array[i];
        let local_filename = local_job.geojson_filename || local_job.filename.replace(/\.png$/i, ".geojson");
        let local_out_path = path.join(geojson_dir, local_filename);
        let local_res = sites_ia_ras_geojson.C_buildPeriodGeoJson(crawl_obj.leaf_records_array, dicts_obj, local_job, local_out_path);
        if (local_res) {
          all_results_array.push(local_res);
          console.log(`[sites_ia_ras_geojson] Step C (${i + 1}/${all_jobs_array.length}): Wrote ${local_res.filename} -> ${local_res.feature_count} points, ${local_res.total_sites_count} sites across ${local_res.oblasts_with_sites_count} oblasts (${(local_res.file_size_bytes/1024).toFixed(1)} KB)`);
        }
      }

      summary_obj = {
        all_site_types_selected: true,
        api_base_url: config_obj.api_base_url,
        crs: "EPSG:4326 (WGS84 [longitude, latitude])",
        elapsed_seconds: Number(((Date.now() - start_ms)/1000).toFixed(2)),
        extracted_at_utc: new Date().toISOString(),
        federal_districts_count: crawl_obj.federal_districts_count,
        leaf_locations_count: crawl_obj.leaf_records_array.length,
        oblasts_count: crawl_obj.oblasts_count,
        period_geojsons: all_results_array,
        residual_parent_locations_count: crawl_obj.residual_nodes_count,
        site_types_dictionary: dicts_obj.types_array,
        source_url: "https://archaeolog.ru/oanmap/",
        total_nodes_queried: crawl_obj.total_nodes_queried
      };

      fs.writeFileSync(summary_path, JSON.stringify(summary_obj, null, 2), "utf8");
      console.log(`[sites_ia_ras_geojson] Step D complete. Saved GeoJSON summary manifest to ${summary_path}`);
    } finally {
      agent_obj.destroy();
    }

    //Return statement
    return summary_obj;
  };


  /**
   * Fetches a binary Buffer over HTTPS with keep-alive pooling and exponential backoff retries.
   * @alias sites_ia_ras_geojson.fetchBuffer
   *
   * @param {string} arg0_url - Target HTTPS URL.
   * @param {Object} arg1_config_obj - Configuration object.
   * @param {Object} [arg2_options]
   *
   * @returns {Promise<Buffer|null>}
   */
  sites_ia_ras_geojson.fetchBuffer = function (arg0_url, arg1_config_obj, arg2_options) {
    //Convert from parameters
    let url = arg0_url;
    let config_obj = (arg1_config_obj) ? arg1_config_obj : {};
    let options = (arg2_options) ? arg2_options : {};

    //Declare local instance variables
    let max_retries = (config_obj.http_retries !== undefined) ? Number(config_obj.http_retries) : 4;
    let timeout_ms = (config_obj.http_timeout_ms !== undefined) ? Number(config_obj.http_timeout_ms) : 20000;

    //Guard clauses
    if (!url) {
      console.error("[sites_ia_ras_geojson.fetchBuffer] Empty URL.");
      return Promise.resolve(null);
    }


    //Return statement
    return new Promise(function (resolve) {
      let attemptRequest = function (arg0_retries_left) {
        let local_retries = arg0_retries_left;
        let local_req = https.get(url, {
          agent: options.agent_obj,
          headers: {
            "Accept": "application/json, */*",
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
            console.error(`[sites_ia_ras_geojson.fetchBuffer] HTTP ${res.statusCode} on ${url}`);
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
          console.error(`[sites_ia_ras_geojson.fetchBuffer] Network error on ${url}:`, err.message);
          resolve(null);
        });
      };

      attemptRequest(max_retries);
    });
  };


  /**
   * Fetches and parses a JSON response from the OANMAP API.
   * @alias sites_ia_ras_geojson.fetchJson
   *
   * @param {string} arg0_url - Target HTTPS URL.
   * @param {Object} arg1_config_obj - Configuration object.
   * @param {Object} [arg2_options]
   *
   * @returns {Promise<*>}
   */
  sites_ia_ras_geojson.fetchJson = async function (arg0_url, arg1_config_obj, arg2_options) {
    //Convert from parameters
    let url = arg0_url;
    let config_obj = arg1_config_obj;
    let options = (arg2_options) ? arg2_options : {};

    //Declare local instance variables
    let raw_buf = null;

    raw_buf = await sites_ia_ras_geojson.fetchBuffer(url, config_obj, options);
    if (!raw_buf) return null;

    try {
      //Return statement
      return JSON.parse(raw_buf.toString("utf8"));
    } catch (e) {
      console.error(`[sites_ia_ras_geojson.fetchJson] Invalid JSON from ${url}:`, e.message);
      return null;
    }
  };


  /**
   * Loads the JSON5 configuration file from histmap/1.data_raw/sites_IA_RAS/config/sites_ia_ras.json5.
   * @alias sites_ia_ras_geojson.loadConfig
   *
   * @param {string} [arg0_config_path] - Optional explicit path to JSON5 configuration file.
   *
   * @returns {Object|null}
   */
  sites_ia_ras_geojson.loadConfig = function (arg0_config_path) {
    //Convert from parameters
    let config_path = arg0_config_path;

    //Declare local instance variables
    let default_path = path.resolve(__dirname, "config/sites_ia_ras.json5");
    let resolved_path = (config_path) ? path.resolve(config_path) : default_path;

    //Guard clauses
    if (!fs.existsSync(resolved_path)) {
      console.error(`[sites_ia_ras_geojson.loadConfig] Config file not found at ${resolved_path}`);
      return null;
    }


    //Return statement
    return JSON5.parse(fs.readFileSync(resolved_path, "utf8"));
  };


  /**
   * Parses a raw /api/map/reg?r=<id> tuple payload into a normalised region record
   * with WGS84 coordinates, bounding box, counts by type/epoch and child stubs.
   * @alias sites_ia_ras_geojson.parseRegPayload
   *
   * @param {*} arg0_raw_res - Raw parsed JSON response from /api/map/reg.
   *
   * @returns {Object|null}
   */
  sites_ia_ras_geojson.parseRegPayload = function (arg0_raw_res) {
    //Convert from parameters
    let raw_res = arg0_raw_res;

    //Declare local instance variables
    let admin_level = 0;
    let base_name = "";
    let bbox_wgs84 = null;
    let children_stubs_array = [];
    let counts_by_epoch = {};
    let counts_by_type = {};
    let is_unspec = false;
    let lat = null;
    let lon = null;
    let payload = null;
    let raw_children = [];
    let region_id = 0;
    let total_sites = 0;

    //Guard clauses
    if (!Array.isArray(raw_res) || !Array.isArray(raw_res[1])) return null;


    payload = raw_res[1];
    region_id = Number(payload[0]);
    base_name = (payload[1] !== null && payload[1] !== undefined) ? String(payload[1]).trim() : `region_${region_id}`;
    is_unspec = Boolean(payload[2]);
    admin_level = Number(payload[3]) || 0;

    if (Array.isArray(payload[4]) && payload[4].length >= 2) {
      let local_lat = Number(payload[4][0]);
      let local_lon = Number(payload[4][1]);
      if (Number.isFinite(local_lat) && Number.isFinite(local_lon)) {
        lat = local_lat;
        lon = local_lon;
      }
    }

    if (payload[5] && typeof payload[5] === "object" && !Array.isArray(payload[5])) {
      let local_tkeys = Object.keys(payload[5]);
      for (let i = 0; i < local_tkeys.length; i++) {
        let local_k = local_tkeys[i];
        let local_v = Number(payload[5][local_k]) || 0;
        counts_by_type[local_k] = local_v;
        total_sites += local_v;
      }
    }

    if (payload[6] && typeof payload[6] === "object" && !Array.isArray(payload[6])) {
      let local_ekeys = Object.keys(payload[6]);
      for (let i = 0; i < local_ekeys.length; i++) {
        let local_k = local_ekeys[i];
        counts_by_epoch[local_k] = Number(payload[6][local_k]) || 0;
      }
    }

    if (Array.isArray(payload[7]) && payload[7].length >= 2 && Array.isArray(payload[7][0]) && Array.isArray(payload[7][1])) {
      let local_sw_lat = Number(payload[7][0][0]);
      let local_sw_lon = Number(payload[7][0][1]);
      let local_ne_lat = Number(payload[7][1][0]);
      let local_ne_lon = Number(payload[7][1][1]);
      if (Number.isFinite(local_sw_lat) && Number.isFinite(local_sw_lon) && Number.isFinite(local_ne_lat) && Number.isFinite(local_ne_lon))
        bbox_wgs84 = [
          [local_sw_lon, local_sw_lat],
          [local_ne_lon, local_ne_lat]
        ];
    }

    raw_children = (Array.isArray(payload[8])) ? payload[8] : [];
    for (let i = 0; i < raw_children.length; i++) {
      let local_ch = raw_children[i];
      if (Array.isArray(local_ch) && local_ch.length >= 2)
        children_stubs_array.push({
          count: Number(local_ch[5]) || 0,
          name_ru: String(local_ch[1]).trim(),
          region_id: Number(local_ch[0])
        });
    }

    //Return statement
    return {
      admin_level: admin_level,
      bbox_wgs84: bbox_wgs84,
      children_stubs_array: children_stubs_array,
      counts_by_epoch: counts_by_epoch,
      counts_by_type: counts_by_type,
      federal_district_id: null,
      federal_district_name_ru: null,
      is_residual_parent: false,
      is_unspecified_subregion: is_unspec,
      lat: lat,
      lon: lon,
      name_ru: (is_unspec) ? `${base_name} (без уточнения)` : base_name,
      oblast_id: null,
      oblast_name_ru: null,
      region_id: region_id,
      total_sites_all_periods: total_sites
    };
  };


  /**
   * Executes an asynchronous callback across an array of items with bounded concurrency.
   * @alias sites_ia_ras_geojson.runPool
   *
   * @param {Array<*>} arg0_items_array - Work items to process.
   * @param {number} arg1_concurrency - Maximum concurrent tasks.
   * @param {Function} arg2_worker_fn - Async callback receiving (item, index).
   *
   * @returns {Promise<void>}
   */
  sites_ia_ras_geojson.runPool = async function (arg0_items_array, arg1_concurrency, arg2_worker_fn) {
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
}


//CLI entrypoint when executed directly via Node.js
if (typeof require !== "undefined" && require.main === module) {
  sites_ia_ras_geojson.D_extractAllPeriodGeoJsons().then(function (arg0_summary) {
    if (!arg0_summary) {
      process.exitCode = 1;
      return;
    }
    console.log(`[sites_ia_ras_geojson] Successfully generated ${arg0_summary.period_geojsons.length} all-Russia GeoJSON files.`);
  });
}

