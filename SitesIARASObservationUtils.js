//Import modules
let fs = require("fs");
let path = require("path");
let { PNG } = require("pngjs");
let SitesIARASResidualKriging = require("./SitesIARASResidualKriging.js");

//Initialise functions
{
  /**
   * Land-mask construction, IA RAS GeoJSON observation loading, oblast-area-conserving raion catchment regularisation, Belarus/Ukraine cross-frontier conditioning and Empirical Bayes oblast survey-completeness harmonisation for the IA RAS (OANMAP) Residual Kriging pipeline.
   *
   * @class SitesIARASObservationUtils
   * @extends SitesIARASResidualKriging
   */
  global.SitesIARASObservationUtils = class extends SitesIARASResidualKriging {
    /**
     * Step A: Builds the 5-arcminute (4320x2160) land-area mask encompassing only the modern Russian Federation (excluding Kaliningrad) and adding Crimea.
     * @alias SitesIARASObservationUtils.A_buildRussiaCrimeaMask
     *
     * @param {Object} [arg0_options]
     *  @param {Object} [arg0_options.config]
     *  @param {string} [arg0_options.project_root]
     *
     * @returns {Object}
     */
    static A_buildRussiaCrimeaMask (arg0_options) {
      //Convert from parameters
      let options = (arg0_options) ? arg0_options : {};

      //Initialise options
      let config = (options.config) ? options.config : this.loadConfig();
      let project_root = (options.project_root) ? options.project_root : path.resolve(__dirname, "../../../../../../");

      //Declare local instance variables
      let bfs_dirs = [[-1, 0], [1, 0], [0, -1], [0, 1]];
      let bfs_head = 0;
      let bfs_queue = [];
      let cell_land_area;
      let cell_ux;
      let cell_uy;
      let cell_uz;
      let class_grid;
      let crimea_bbox = config.kriging_config.crimea_bbox;
      let crimea_cell_count = 0;
      let crimea_poly = [];
      let cshapes_geojson;
      let cshapes_path = path.join(project_root, "saves", "CShapes-2.0.geojson");
      let dist_grid;
      let earth_radius_km = config.kriging_config.earth_radius_km;
      let geocodes_path = path.join(project_root, "histmap", "1.data_raw", "admin_modern", "geocodes.png");
      let geocodes_png = PNG.sync.read(fs.readFileSync(geocodes_path));
      let grid_height = config.kriging_config.grid_height;
      let grid_width = config.kriging_config.grid_width;
      let kaliningrad_bbox = config.kriging_config.kaliningrad_bbox;
      let kaliningrad_excluded_count = 0;
      let land_area_grid;
      let land_area_path = path.join(project_root, "histmap", "1.data_raw", "metadata_HYDE", "general_rasters", "land_area.png");
      let land_area_png = PNG.sync.read(fs.readFileSync(land_area_path));
      let mask_grid;
      let max_bfs_dist = config.kriging_config.coastal_bfs_max_distance_px;
      let mean_cell_land_area_km2;
      let pixel_to_valid_idx;
      let rus_feature;
      let rus_rgb = config.kriging_config.russia_geocode_rgb;
      let total_land_area_km2 = 0;
      let total_pixels = grid_width*grid_height;
      let valid_indices = [];

      //Extract Crimea polygon from CShapes-2.0 2019 Russia feature
      cshapes_geojson = JSON.parse(fs.readFileSync(cshapes_path, "utf8"));
      for (let i = 0; i < cshapes_geojson.features.length; i++) {
        let local_feature = cshapes_geojson.features[i];
        let local_props = local_feature.properties;

        if (
          local_props.gwcode === config.kriging_config.cshapes_crimea_gwcode &&
          local_props.gweyear === config.kriging_config.cshapes_crimea_gweyear
        ) {
          rus_feature = local_feature;
          break;
        }
      }

      if (rus_feature && rus_feature.geometry && rus_feature.geometry.coordinates)
        for (let i = 0; i < rus_feature.geometry.coordinates.length; i++) {
          let local_max_lat = -90;
          let local_max_lon = -180;
          let local_min_lat = 90;
          let local_min_lon = 180;
          let local_ring = rus_feature.geometry.coordinates[i][0];

          for (let x = 0; x < local_ring.length; x++) {
            let local_pt = local_ring[x];

            local_max_lon = Math.max(local_max_lon, local_pt[0]);
            local_min_lon = Math.min(local_min_lon, local_pt[0]);
            local_max_lat = Math.max(local_max_lat, local_pt[1]);
            local_min_lat = Math.min(local_min_lat, local_pt[1]);
          }

          if (local_min_lon > 30 && local_max_lon < 38 && local_min_lat > 44 && local_max_lat < 47) {
            crimea_poly = local_ring;
            break;
          }
        }

      //Initialise classification arrays (1 = Russia excl. Kaliningrad + Crimea, 2 = Foreign or Kaliningrad)
      class_grid = new Uint8Array(total_pixels);
      dist_grid = new Uint8Array(total_pixels);
      dist_grid.fill(255);
      land_area_grid = new Float32Array(total_pixels);
      mask_grid = new Uint8Array(total_pixels);
      pixel_to_valid_idx = new Int32Array(total_pixels);
      pixel_to_valid_idx.fill(-1);

      for (let i = 0; i < grid_height; i++) {
        let local_lat = 90 - (i + 0.5)/12;

        for (let x = 0; x < grid_width; x++) {
          let local_b;
          let local_g;
          let local_idx = i*grid_width + x;
          let local_is_crimea = false;
          let local_is_kgd = false;
          let local_is_rus = false;
          let local_la;
          let local_lon = -180 + (x + 0.5)/12;
          let local_px = local_idx*4;
          let local_r;

          local_la = (
            (land_area_png.data[local_px] << 24) |
            (land_area_png.data[local_px + 1] << 16) |
            (land_area_png.data[local_px + 2] << 8) |
            land_area_png.data[local_px + 3]
          ) >>> 0;
          land_area_grid[local_idx] = local_la;

          local_r = geocodes_png.data[local_px];
          local_g = geocodes_png.data[local_px + 1];
          local_b = geocodes_png.data[local_px + 2];

          local_is_rus = (local_r === rus_rgb[0] && local_g === rus_rgb[1] && local_b === rus_rgb[2]);
          local_is_kgd = (
            local_lon >= kaliningrad_bbox.min_lon &&
            local_lon <= kaliningrad_bbox.max_lon &&
            local_lat >= kaliningrad_bbox.min_lat &&
            local_lat <= kaliningrad_bbox.max_lat
          );

          if (local_is_rus && local_is_kgd) {
            class_grid[local_idx] = 2;
            dist_grid[local_idx] = 0;
            bfs_queue.push(local_idx);
            if (local_la > 0) kaliningrad_excluded_count++;
          } else {
            if (!local_is_rus)
              local_is_crimea = this.isCellInCrimea(local_lon, local_lat, crimea_poly, crimea_bbox);

            if (local_is_rus || local_is_crimea) {
              class_grid[local_idx] = 1;
              dist_grid[local_idx] = 0;
              bfs_queue.push(local_idx);
              if (local_is_crimea && local_la > 0) crimea_cell_count++;
            } else if (local_r !== 0 || local_g !== 0 || local_b !== 0) {
              class_grid[local_idx] = 2;
              dist_grid[local_idx] = 0;
              bfs_queue.push(local_idx);
            }
          }
        }
      }

      //Propagate nearest country class across unmapped coastal fringe cells
      for (let i = 0; i < bfs_queue.length; i++) {
        let local_curr = bfs_queue[bfs_head++];
        let local_cx = local_curr % grid_width;
        let local_cy = Math.floor(local_curr/grid_width);
        let local_dist = dist_grid[local_curr];

        if (local_dist < max_bfs_dist)
          for (let x = 0; x < bfs_dirs.length; x++) {
            let local_dir = bfs_dirs[x];
            let local_nx = (local_cx + local_dir[1] + grid_width) % grid_width;
            let local_ny = local_cy + local_dir[0];

            if (local_ny >= 0 && local_ny < grid_height) {
              let local_nidx = local_ny*grid_width + local_nx;

              if (dist_grid[local_nidx] === 255) {
                class_grid[local_nidx] = class_grid[local_curr];
                dist_grid[local_nidx] = local_dist + 1;
                bfs_queue.push(local_nidx);
              }
            }
          }
      }

      //Finalise land-area mask (strictly excluding Kaliningrad bbox and requiring land_area > 0)
      for (let i = 0; i < grid_height; i++) {
        let local_lat = 90 - (i + 0.5)/12;

        for (let x = 0; x < grid_width; x++) {
          let local_idx = i*grid_width + x;
          let local_is_kgd;
          let local_la = land_area_grid[local_idx];
          let local_lon = -180 + (x + 0.5)/12;

          local_is_kgd = (
            local_lon >= kaliningrad_bbox.min_lon &&
            local_lon <= kaliningrad_bbox.max_lon &&
            local_lat >= kaliningrad_bbox.min_lat &&
            local_lat <= kaliningrad_bbox.max_lat
          );

          //Round HYDE 79.5N horizontal truncation artifact on October Revolution Island (Severnaya Zemlya, rows 126..128)
          let local_is_arctic_box_clip = false;
          if (i >= 126 && i <= 128 && x >= 3290 && x <= 3365) {
            if (i === 126 && (x < 3314 || x > 3341 || (x >= 3328 && x <= 3331))) local_is_arctic_box_clip = true;
            else if (i === 127 && (x < 3304 || x > 3349)) local_is_arctic_box_clip = true;
            else if (i === 128 && (x < 3298 || x > 3355)) local_is_arctic_box_clip = true;
          }

          if (local_la > 0 && class_grid[local_idx] === 1 && !local_is_kgd && !local_is_arctic_box_clip) {
            mask_grid[local_idx] = 1;
            pixel_to_valid_idx[local_idx] = valid_indices.length;
            total_land_area_km2 += local_la;
            valid_indices.push(local_idx);
          }
        }
      }

      //Precompute 3D unit-sphere coordinates and cell land areas for all valid mask cells
      cell_land_area = new Float32Array(valid_indices.length);
      cell_ux = new Float32Array(valid_indices.length);
      cell_uy = new Float32Array(valid_indices.length);
      cell_uz = new Float32Array(valid_indices.length);
      mean_cell_land_area_km2 = total_land_area_km2/valid_indices.length;

      for (let i = 0; i < valid_indices.length; i++) {
        let local_cos_lat;
        let local_idx = valid_indices[i];
        let local_lat = 90 - (Math.floor(local_idx/grid_width) + 0.5)/12;
        let local_lat_rad = local_lat*Math.PI/180;
        let local_lon = -180 + ((local_idx % grid_width) + 0.5)/12;
        let local_lon_rad = local_lon*Math.PI/180;

        local_cos_lat = Math.cos(local_lat_rad);
        cell_land_area[i] = land_area_grid[local_idx];
        cell_ux[i] = local_cos_lat*Math.cos(local_lon_rad);
        cell_uy[i] = local_cos_lat*Math.sin(local_lon_rad);
        cell_uz[i] = Math.sin(local_lat_rad);
      }

      //Return statement
      return {
        cell_land_area: cell_land_area,
        cell_ux: cell_ux,
        cell_uy: cell_uy,
        cell_uz: cell_uz,
        crimea_cell_count: crimea_cell_count,
        earth_radius_km: earth_radius_km,
        grid_height: grid_height,
        grid_width: grid_width,
        kaliningrad_excluded_count: kaliningrad_excluded_count,
        land_area_grid: land_area_grid,
        mask_grid: mask_grid,
        mean_cell_land_area_km2: mean_cell_land_area_km2,
        pixel_to_valid_idx: pixel_to_valid_idx,
        project_root: project_root,
        total_land_area_km2: total_land_area_km2,
        valid_cell_count: valid_indices.length,
        valid_indices: Int32Array.from(valid_indices)
      };
    }


    /**
     * Step B: Loads the 12 IA RAS GeoJSON files plus adjacent Belarus/Ukraine conditioning raions within 250 km, excludes Kaliningrad, preserves Crimea, reallocates oblast-level unspecified subregions, applies Empirical Bayes raion-local unspecified allocation, computes oblast-area-conserving geodesic Voronoi catchment areas and applies hierarchical Empirical Bayes oblast survey harmonisation.
     * @alias SitesIARASObservationUtils.B_loadRaionObservations
     *
     * @param {Object} arg0_mask_data
     * @param {Object} [arg1_options]
     *  @param {Object} [arg1_options.config]
     *
     * @returns {Object}
     */
    static B_loadRaionObservations (arg0_mask_data, arg1_options) {
      //Convert from parameters
      let mask_data = arg0_mask_data;
      let options = (arg1_options) ? arg1_options : {};

      //Initialise options
      let config = (options.config) ? options.config : this.loadConfig();

      //Declare local instance variables
      let by_oblast_map = new Map();
      let catchment_smooth_radius_px;
      let cell_nearest_raion = new Int32Array(mask_data.valid_cell_count);
      let cell_radius_km;
      let cell_ux = mask_data.cell_ux;
      let cell_uy = mask_data.cell_uy;
      let cell_uz = mask_data.cell_uz;
      let domestic_raion_count = 0;
      let excluded_oblast_set = new Set(config.kriging_config.excluded_oblast_ids);
      let forest_grid = this.readAscGrid(
        path.join(mask_data.project_root, config.kriging_config.covariate_paths.forest_asc),
        mask_data.grid_width*mask_data.grid_height
      );
      let frontier_bundle;
      let frontier_list = [];
      let geojson_dir = path.join(__dirname, config.output_geojson_subfolder);
      let kaliningrad_bbox = config.kriging_config.kaliningrad_bbox;
      let kept_domestic = [];
      let land_area_grid = mask_data.land_area_grid;
      let median_radius_km;
      let median_voronoi_area_km2;
      let oblast_raions_map = new Map();
      let period_configs = config.periods;
      let period_totals = {};
      let q25_voronoi_area_km2;
      let q75_voronoi_area_km2;
      let raion_area_km2;
      let raion_cell_counts;
      let raion_list = [];
      let raion_map = new Map();
      let raion_radius_km;
      let raion_ux;
      let raion_uy;
      let raion_uz;
      let raion_wood_cnt;
      let raion_wood_sum;
      let raw_cell_radius = new Float32Array(mask_data.valid_cell_count);
      let sorted_areas = [];
      let unspec_subregion_list = [];
      let unspec_subregion_map = new Map();
      let valid_indices = mask_data.valid_indices;

      for (let i = 0; i < period_configs.length; i++) {
        let local_file = path.join(geojson_dir, period_configs[i].geojson_filename);
        let local_gj = JSON.parse(fs.readFileSync(local_file, "utf8"));
        let local_pkey = period_configs[i].key;

        period_totals[local_pkey] = 0;

        for (let x = 0; x < local_gj.features.length; x++) {
          let local_coords = local_gj.features[x].geometry.coordinates;
          let local_lat = local_coords[1];
          let local_lon = local_coords[0];
          let local_props = local_gj.features[x].properties;
          let local_target_map;

          if (excluded_oblast_set.has(local_props.oblast_id)) continue;
          if (
            local_lon >= kaliningrad_bbox.min_lon &&
            local_lon <= kaliningrad_bbox.max_lon &&
            local_lat >= kaliningrad_bbox.min_lat &&
            local_lat <= kaliningrad_bbox.max_lat
          ) continue;

          local_target_map = (local_props.is_unspecified_subregion) ? unspec_subregion_map : raion_map;

          if (!local_target_map.has(local_props.region_id)) {
            let local_cos_lat = Math.cos(local_lat*Math.PI/180);
            let local_lat_rad = local_lat*Math.PI/180;
            let local_lon_rad = local_lon*Math.PI/180;

            local_target_map.set(local_props.region_id, {
              eb_densities: {},
              id: local_props.region_id,
              is_frontier_buffer: false,
              lat: local_lat,
              lon: local_lon,
              name_ru: local_props.name_ru,
              oblast_id: local_props.oblast_id,
              oblast_name_ru: local_props.oblast_name_ru,
              periods: {},
              radius_km: 0,
              raw_periods: {},
              total_sites_all_periods: local_props.total_sites_all_periods || 0,
              ux: local_cos_lat*Math.cos(local_lon_rad),
              uy: local_cos_lat*Math.sin(local_lon_rad),
              uz: Math.sin(local_lat_rad),
              voronoi_area_km2: 0
            });
          }

          let local_entry = local_target_map.get(local_props.region_id);

          local_entry.periods[local_pkey] = (local_entry.periods[local_pkey] || 0) + local_props.site_count;
          local_entry.raw_periods[local_pkey] = (local_entry.raw_periods[local_pkey] || 0) + local_props.site_count;
          period_totals[local_pkey] += local_props.site_count;
        }
      }

      raion_list = Array.from(raion_map.values());
      domestic_raion_count = raion_list.length;
      unspec_subregion_list = Array.from(unspec_subregion_map.values());

      //Append Belarusian and Ukrainian cross-frontier conditioning raions within 250 km (for Kursk/Bryansk salients and northern Crimea)
      frontier_bundle = this.loadBelarusUkraineFrontierRaions(mask_data, config);
      for (let i = 0; i < frontier_bundle.raion_list.length; i++)
        raion_list.push(frontier_bundle.raion_list[i]);
      for (let i = 0; i < frontier_bundle.unspec_subregion_list.length; i++)
        unspec_subregion_list.push(frontier_bundle.unspec_subregion_list[i]);

      for (let i = 0; i < raion_list.length; i++) {
        let local_raion = raion_list[i];

        if (!oblast_raions_map.has(local_raion.oblast_id))
          oblast_raions_map.set(local_raion.oblast_id, []);
        oblast_raions_map.get(local_raion.oblast_id).push(local_raion);
      }

      //Reallocate oblast-level unspecified subregion counts proportionally across the oblast's regular raions
      for (let i = 0; i < unspec_subregion_list.length; i++) {
        let local_oblast_raions = oblast_raions_map.get(unspec_subregion_list[i].oblast_id) || [];
        let local_unspec = unspec_subregion_list[i];

        if (local_oblast_raions.length > 0)
          for (let x = 0; x < period_configs.length; x++) {
            let local_add_count = local_unspec.periods[period_configs[x].key] || 0;
            let local_pkey = period_configs[x].key;

            if (local_add_count > 0) {
              let local_period_sum = 0;
              let local_total_sum = 0;

              for (let y = 0; y < local_oblast_raions.length; y++) {
                local_period_sum += (local_oblast_raions[y].raw_periods[local_pkey] || 0);
                local_total_sum += (local_oblast_raions[y].total_sites_all_periods || 1);
              }

              for (let y = 0; y < local_oblast_raions.length; y++) {
                let local_raion = local_oblast_raions[y];
                let local_share = (local_period_sum > 0) ?
                  (local_raion.raw_periods[local_pkey] || 0)/local_period_sum :
                  (local_raion.total_sites_all_periods || 1)/local_total_sum;

                local_raion.periods[local_pkey] = (local_raion.periods[local_pkey] || 0) + local_add_count*local_share;
              }
            }
          }
      }

      //Apply parameter-free Empirical Bayes Dirichlet-Multinomial unspecified site allocation blending raion and oblast dated period shares
      for (let i = 0; i < raion_list.length; i++) {
        let local_dated_sum = 0;
        let local_oblast_dated_sum = 0;
        let local_oblast_period_sums = {};
        let local_oblast_raions;
        let local_prior_conc = 0;
        let local_raion = raion_list[i];
        let local_unspec_sites = local_raion.periods.unspecified || 0;

        if (local_unspec_sites > 0) {
          local_oblast_raions = oblast_raions_map.get(local_raion.oblast_id) || [local_raion];
          for (let x = 0; x < period_configs.length; x++) {
            let local_pkey = period_configs[x].key;

            if (local_pkey !== "unspecified") {
              local_dated_sum += (local_raion.periods[local_pkey] || 0);
              local_oblast_period_sums[local_pkey] = 0;
            }
          }

          for (let x = 0; x < local_oblast_raions.length; x++)
            for (let y = 0; y < period_configs.length; y++) {
              let local_pkey = period_configs[y].key;

              if (local_pkey !== "unspecified") {
                let local_v = local_oblast_raions[x].periods[local_pkey] || 0;

                local_oblast_period_sums[local_pkey] += local_v;
                local_oblast_dated_sum += local_v;
              }
            }

          local_prior_conc = local_oblast_dated_sum/Math.max(1, local_oblast_raions.length);
          let local_total_ref = local_dated_sum + local_prior_conc;

          if (local_total_ref > 0) {
            let local_empirical_dated_fraction = (local_dated_sum + local_prior_conc)/(local_dated_sum + local_prior_conc + local_unspec_sites);

            for (let x = 0; x < period_configs.length; x++) {
              let local_pkey = period_configs[x].key;

              if (local_pkey !== "unspecified") {
                let local_obl_share = (local_oblast_dated_sum > 0) ? local_oblast_period_sums[local_pkey]/local_oblast_dated_sum : 0;
                let local_post_share = ((local_raion.periods[local_pkey] || 0) + local_prior_conc*local_obl_share)/local_total_ref;

                local_raion.periods[local_pkey] = (local_raion.periods[local_pkey] || 0) + local_unspec_sites*local_empirical_dated_fraction*local_post_share;
              }
            }
          }
        }
      }

      //Compute initial geodesic Voronoi land area (km2) and WWF forest cover fraction for domestic raions
      raion_cell_counts = new Int32Array(raion_list.length);
      raion_ux = new Float32Array(raion_list.length);
      raion_uy = new Float32Array(raion_list.length);
      raion_uz = new Float32Array(raion_list.length);
      raion_wood_cnt = new Int32Array(raion_list.length);
      raion_wood_sum = new Float64Array(raion_list.length);

      for (let i = 0; i < raion_list.length; i++) {
        raion_ux[i] = raion_list[i].ux;
        raion_uy[i] = raion_list[i].uy;
        raion_uz[i] = raion_list[i].uz;
      }

      for (let i = 0; i < valid_indices.length; i++) {
        let local_best_dot = -2;
        let local_best_k = 0;
        let local_cx = cell_ux[i];
        let local_cy = cell_uy[i];
        let local_cz = cell_uz[i];
        let local_idx = valid_indices[i];

        for (let x = 0; x < domestic_raion_count; x++) {
          let local_dot = local_cx*raion_ux[x] + local_cy*raion_uy[x] + local_cz*raion_uz[x];

          if (local_dot > local_best_dot) {
            local_best_dot = local_dot;
            local_best_k = x;
          }
        }

        raion_list[local_best_k].voronoi_area_km2 += land_area_grid[local_idx];
        raion_cell_counts[local_best_k]++;
        raion_wood_cnt[local_best_k]++;
        raion_wood_sum[local_best_k] += (forest_grid[local_idx] > 0) ? 1 : 0;
      }

      for (let i = 0; i < raion_list.length; i++) {
        let local_r = raion_list[i];

        if (raion_wood_cnt[i] > 0) {
          local_r.wooded_frac = raion_wood_sum[i]/raion_wood_cnt[i];
        } else {
          let local_col = Math.min(4319, Math.max(0, Math.floor((local_r.lon + 180)*12)));
          let local_row = Math.min(2159, Math.max(0, Math.floor((90 - local_r.lat)*12)));

          local_r.wooded_frac = (forest_grid[local_row*4320 + local_col] > 0) ? 1 : 0;
        }
      }

      //Merge federal-city enclaves (Sevastopol 5346 -> Republic of Crimea 5319, Moscow City 5243 -> Moscow Oblast 4199) into their surrounding oblast
      for (let i = 0; i < domestic_raion_count; i++) {
        if (raion_list[i].oblast_id === 5346)
          raion_list[i].oblast_id = 5319;
        if (raion_list[i].oblast_id === 5243)
          raion_list[i].oblast_id = 4199;
      }

      //Apply ecological conditioning on open steppe and Kuban kurgan fields (lat < 52,8N) during settled periods, matching SitesBelarusUkraineObservationUtils
      for (let i = 0; i < domestic_raion_count; i++) {
        let local_r = raion_list[i];

        if (local_r.lat < 52.8 && local_r.oblast_id !== 5319) {
          let local_eco_mod;
          let local_lat_w = Math.max(0, Math.min(1, (52.8 - local_r.lat)/2.5));
          let local_steppe_mod;
          let local_wf = local_r.wooded_frac || 0;

          local_steppe_mod = 0.22 + 0.78*(local_wf*local_wf*(3 - 2*local_wf));
          local_eco_mod = 1 - local_lat_w*(1 - local_steppe_mod);
          local_r.periods.migration_period = (local_r.periods.migration_period || 0)*local_eco_mod;
          local_r.periods.middle_ages = (local_r.periods.middle_ages || 0)*local_eco_mod;
          local_r.periods.early_modern_14_17c = (local_r.periods.early_modern_14_17c || 0)*(0.35 + 0.65*local_eco_mod);
        }
      }

      //Consolidate sub-raion micro-points (urban okrugs / New Moscow poseleniya < 18 km apart or < 850 km2 within 32 km in the same oblast) into their parent raion anchor so site counts S_k are aggregated at true raion support
      for (let i = 0; i < domestic_raion_count; i++) {
        let local_r = raion_list[i];

        if (!by_oblast_map.has(local_r.oblast_id))
          by_oblast_map.set(local_r.oblast_id, []);
        by_oblast_map.get(local_r.oblast_id).push(local_r);
      }
      for (let i = domestic_raion_count; i < raion_list.length; i++)
        frontier_list.push(raion_list[i]);

      for (let [local_obl_id, local_rlist] of by_oblast_map.entries()) {
        let local_anchors = [];

        local_rlist.sort((a, b) => (b.voronoi_area_km2*(10 + b.total_sites_all_periods)) - (a.voronoi_area_km2*(10 + a.total_sites_all_periods)));

        for (let i = 0; i < local_rlist.length; i++) {
          let local_best_a = null;
          let local_best_dist = Infinity;
          let local_r = local_rlist[i];

          for (let x = 0; x < local_anchors.length; x++) {
            let local_a = local_anchors[x];
            let local_dot = Math.max(-1, Math.min(1, local_r.ux*local_a.ux + local_r.uy*local_a.uy + local_r.uz*local_a.uz));
            let local_dist = mask_data.earth_radius_km*Math.acos(local_dot);

            if (local_dist < local_best_dist) {
              local_best_dist = local_dist;
              local_best_a = local_a;
            }
          }

          if (local_best_a && (local_best_dist < 18 || (local_r.voronoi_area_km2 < 850 && local_best_dist < 32))) {
            local_best_a.voronoi_area_km2 += local_r.voronoi_area_km2;
            local_best_a.total_sites_all_periods += local_r.total_sites_all_periods;
            for (let x = 0; x < period_configs.length; x++) {
              let local_pk = period_configs[x].key;

              local_best_a.periods[local_pk] = (local_best_a.periods[local_pk] || 0) + (local_r.periods[local_pk] || 0);
              local_best_a.raw_periods[local_pk] = (local_best_a.raw_periods[local_pk] || 0) + (local_r.raw_periods[local_pk] || 0);
            }
          } else {
            local_anchors.push(local_r);
            kept_domestic.push(local_r);
          }
        }

        //Regularise extreme single-raion museum-reserve / salvage-excavation spikes outside the Central/NW Russian core (lat >= 52,8N && lon <= 46,5E)
        if (local_anchors.length >= 4 && local_obl_id !== 5319) {
          let local_mean_lat = 0;
          let local_mean_lon = 0;

          for (let i = 0; i < local_anchors.length; i++) {
            local_mean_lat += local_anchors[i].lat/local_anchors.length;
            local_mean_lon += local_anchors[i].lon/local_anchors.length;
          }

          if (local_mean_lat < 52.8 || local_mean_lon > 46.5)
            for (let i = 0; i < period_configs.length; i++) {
              let local_pk = period_configs[i].key;

              if (local_pk !== "unspecified" && local_pk !== "classical_antiquity") {
                let local_vals = [];

                for (let x = 0; x < local_anchors.length; x++)
                  if ((local_anchors[x].periods[local_pk] || 0) > 0)
                    local_vals.push(local_anchors[x].periods[local_pk]);

                if (local_vals.length >= 4) {
                  local_vals.sort((a, b) => a - b);
                  let local_q50 = local_vals[Math.floor(0.50*(local_vals.length - 1))];
                  let local_q75 = local_vals[Math.floor(0.75*(local_vals.length - 1))];
                  let local_iqr = Math.max(1, local_q75 - local_q50);
                  let local_cap = local_q75 + 1.25*local_iqr;

                  for (let x = 0; x < local_anchors.length; x++) {
                    let local_s = local_anchors[x].periods[local_pk] || 0;

                    if (local_s > local_cap) {
                      let local_ex = local_s - local_cap;

                      local_anchors[x].periods[local_pk] = local_cap + (local_iqr*local_ex)/(local_iqr + local_ex);
                    }
                  }
                }
              }
            }
        }
      }

      raion_list = kept_domestic.concat(frontier_list);
      domestic_raion_count = kept_domestic.length;
      oblast_raions_map = new Map();
      for (let i = 0; i < raion_list.length; i++) {
        let local_r = raion_list[i];

        if (!oblast_raions_map.has(local_r.oblast_id))
          oblast_raions_map.set(local_r.oblast_id, []);
        oblast_raions_map.get(local_r.oblast_id).push(local_r);
      }

      raion_area_km2 = new Float64Array(raion_list.length);
      raion_cell_counts = new Int32Array(raion_list.length);
      raion_radius_km = new Float64Array(raion_list.length);
      raion_ux = new Float32Array(raion_list.length);
      raion_uy = new Float32Array(raion_list.length);
      raion_uz = new Float32Array(raion_list.length);

      for (let i = 0; i < raion_list.length; i++) {
        raion_list[i].voronoi_area_km2 = 0;
        raion_ux[i] = raion_list[i].ux;
        raion_uy[i] = raion_list[i].uy;
        raion_uz[i] = raion_list[i].uz;
      }

      for (let i = 0; i < valid_indices.length; i++) {
        let local_best_dot = -2;
        let local_best_k = 0;
        let local_cx = cell_ux[i];
        let local_cy = cell_uy[i];
        let local_cz = cell_uz[i];
        let local_idx = valid_indices[i];

        for (let x = 0; x < domestic_raion_count; x++) {
          let local_dot = local_cx*raion_ux[x] + local_cy*raion_uy[x] + local_cz*raion_uz[x];

          if (local_dot > local_best_dot) {
            local_best_dot = local_dot;
            local_best_k = x;
          }
        }

        raion_list[local_best_k].voronoi_area_km2 += land_area_grid[local_idx];
        raion_cell_counts[local_best_k]++;
        cell_nearest_raion[i] = local_best_k;
      }

      for (let i = 0; i < domestic_raion_count; i++) {
        let local_raw_area = Math.max(mask_data.mean_cell_land_area_km2, raion_list[i].voronoi_area_km2);

        raion_list[i].voronoi_area_km2 = local_raw_area;
        sorted_areas.push(local_raw_area);
      }
      sorted_areas.sort((a, b) => a - b);
      q25_voronoi_area_km2 = sorted_areas[Math.floor(0.25*sorted_areas.length)];
      median_voronoi_area_km2 = sorted_areas[Math.floor(0.50*sorted_areas.length)];
      q75_voronoi_area_km2 = sorted_areas[Math.floor(0.75*sorted_areas.length)];
      median_radius_km = Math.sqrt(median_voronoi_area_km2/Math.PI);

      for (let [local_obl_id, local_obl_raions] of oblast_raions_map.entries()) {
        let local_obl_vor = 0;
        let local_reg_areas = new Float64Array(local_obl_raions.length);
        let local_reg_sum = 0;

        for (let i = 0; i < local_obl_raions.length; i++) {
          let local_r = local_obl_raions[i];
          let local_vor = (local_r.is_frontier_buffer) ?
            0.78*median_voronoi_area_km2 :
            Math.max(mask_data.mean_cell_land_area_km2, local_r.voronoi_area_km2);

          local_r.voronoi_area_km2 = local_vor;
          local_obl_vor += local_vor;
        }

        let local_mean_vor = local_obl_vor/Math.max(1, local_obl_raions.length);

        for (let i = 0; i < local_obl_raions.length; i++) {
          let local_reg_a = Math.max(0.45*local_mean_vor, Math.min(2.0*local_mean_vor, local_obl_raions[i].voronoi_area_km2));

          local_reg_areas[i] = local_reg_a;
          local_reg_sum += local_reg_a;
        }

        let local_scale = (local_reg_sum > 0) ? (local_obl_vor/local_reg_sum) : 1;

        for (let i = 0; i < local_obl_raions.length; i++) {
          let local_obs_area = Math.max(mask_data.mean_cell_land_area_km2, local_reg_areas[i]*local_scale);
          let local_r = local_obl_raions[i];
          let local_rad_area = Math.max(0.35*q25_voronoi_area_km2, Math.min(q75_voronoi_area_km2, local_obs_area));

          local_r.effective_area_km2 = local_obs_area;
          local_r.radius_km = Math.sqrt(local_rad_area/Math.PI);
        }
      }

      for (let i = 0; i < raion_list.length; i++) {
        raion_area_km2[i] = raion_list[i].effective_area_km2 || median_voronoi_area_km2;
        raion_radius_km[i] = raion_list[i].radius_km || median_radius_km;
      }

      for (let i = 0; i < period_configs.length; i++) {
        let local_pkey = period_configs[i].key;

        for (let x = 0; x < raion_list.length; x++) {
          let local_ak = raion_list[x].effective_area_km2;
          let local_sk = raion_list[x].periods[local_pkey] || 0;

          raion_list[x].eb_densities[local_pkey] = local_sk/local_ak;
        }
      }

      this.harmoniseOblastObservationsEB(raion_list, oblast_raions_map, period_configs, mask_data.earth_radius_km);

      //Construct a continuous (Voronoi-seam-free) local radius field r_cell(i) across the 412,959 grid cells
      for (let i = 0; i < valid_indices.length; i++)
        raw_cell_radius[i] = raion_radius_km[cell_nearest_raion[i]];

      catchment_smooth_radius_px = Math.max(2, Math.round(0.65*median_radius_km/Math.sqrt(mask_data.mean_cell_land_area_km2)));
      cell_radius_km = this.smoothValidFieldOnGrid(mask_data, raw_cell_radius, catchment_smooth_radius_px);

      //Return statement
      return {
        catchment_smooth_radius_px: catchment_smooth_radius_px,
        cell_nearest_raion: cell_nearest_raion,
        cell_radius_km: cell_radius_km,
        domestic_raion_count: domestic_raion_count,
        frontier_raion_count: raion_list.length - domestic_raion_count,
        median_radius_km: median_radius_km,
        median_voronoi_area_km2: median_voronoi_area_km2,
        period_totals: period_totals,
        raion_area_km2: raion_area_km2,
        raion_cell_counts: raion_cell_counts,
        raion_count: raion_list.length,
        raion_list: raion_list,
        raion_radius_km: raion_radius_km,
        raion_ux: raion_ux,
        raion_uy: raion_uy,
        raion_uz: raion_uz,
        unspec_subregion_count: unspec_subregion_list.length
      };
    }


    /**
     * Applies Empirical Bayes spatial-neighbourhood survey-completeness harmonisation across European Russia and Crimea so frontier and peninsula oblasts with partial IA RAS OANMAP medieval permit logging (such as Crimea 5319 and Kursk 4095 / Oryol 1819) are harmonised with their multi-period archaeological potential and Cauchy spatial neighbourhood prior.
     * @alias SitesIARASObservationUtils.harmoniseOblastObservationsEB
     *
     * @param {Array<Object>} arg0_raion_list
     * @param {Map} arg1_oblast_raions_map
     * @param {Array<Object>} arg2_period_configs
     * @param {number} arg3_earth_radius_km
     */
    static harmoniseOblastObservationsEB (
      arg0_raion_list,
      arg1_oblast_raions_map,
      arg2_period_configs,
      arg3_earth_radius_km
    ) {
      //Convert from parameters
      let raion_list = arg0_raion_list;
      let oblast_raions_map = arg1_oblast_raions_map;
      let period_configs = arg2_period_configs;
      let earth_radius_km = arg3_earth_radius_km;

      //Declare local instance variables
      let dated_periods = [];
      let n_raions = raion_list.length;
      let obl_list = [];

      for (let i = 0; i < period_configs.length; i++)
        if (period_configs[i].key !== "unspecified")
          dated_periods.push(period_configs[i].key);

      for (let i = 0; i < n_raions; i++)
        raion_list[i]._idx = i;

      for (let [local_obl_id, local_raions] of oblast_raions_map.entries()) {
        let local_all_s = 0;
        let local_area = 0;
        let local_lat = 0;
        let local_lon = 0;
        let local_ux = 0;
        let local_uy = 0;
        let local_uz = 0;

        for (let i = 0; i < local_raions.length; i++) {
          let local_r = local_raions[i];
          let local_a = local_r.effective_area_km2;

          local_area += local_a;
          local_all_s += (local_r.total_sites_all_periods || 0);
          local_lat += local_a*local_r.lat;
          local_lon += local_a*local_r.lon;
          local_ux += local_a*local_r.ux;
          local_uy += local_a*local_r.uy;
          local_uz += local_a*local_r.uz;
        }

        let local_norm = Math.sqrt(local_ux*local_ux + local_uy*local_uy + local_uz*local_uz) || 1;

        obl_list.push({
          all_z: Math.sqrt(Math.max(0, local_all_s/Math.max(1, local_area))),
          area_km2: local_area,
          id: local_obl_id,
          lat: local_lat/Math.max(1, local_area),
          lon: local_lon/Math.max(1, local_area),
          radius_km: Math.sqrt(local_area/Math.PI),
          raions: local_raions,
          ux: local_ux/local_norm,
          uy: local_uy/local_norm,
          uz: local_uz/local_norm
        });
      }

      for (let i = 0; i < dated_periods.length; i++) {
        let local_all_z_sum = 0;
        let local_obl_means = new Float64Array(obl_list.length);
        let local_per_ratio;
        let local_per_z_sum = 0;
        let local_pkey = dated_periods[i];
        let local_z = new Float64Array(n_raions);

        for (let x = 0; x < n_raions; x++)
          local_z[x] = Math.sqrt(Math.max(0, raion_list[x].eb_densities[local_pkey] || 0));

        for (let x = 0; x < obl_list.length; x++) {
          let local_asum = 0;
          let local_obl = obl_list[x];
          let local_zsum = 0;

          for (let y = 0; y < local_obl.raions.length; y++) {
            let local_r = local_obl.raions[y];
            let local_a = local_r.effective_area_km2;

            local_asum += local_a;
            local_zsum += local_a*local_z[local_r._idx];
          }
          local_obl_means[x] = (local_asum > 0) ? local_zsum/local_asum : 0;

          if (local_obl.lon < 50 && local_obl.all_z > 0) {
            local_all_z_sum += local_obl.area_km2*local_obl.all_z;
            local_per_z_sum += local_obl.area_km2*local_obl_means[x];
          }
        }

        local_per_ratio = (local_all_z_sum > 1e-6) ? local_per_z_sum/local_all_z_sum : 0;

        //Apply upward-only Empirical Bayes support for under-logged European Russian and Crimean oblasts (lon < 47,5E and wooded_frac >= 0,20, or Crimea 5319) without ever Winsorising or shrinking high-density cores downward
        for (let x = 0; x < obl_list.length; x++) {
          let local_obl_x = obl_list[x];

          if (local_obl_x.id !== 5319 && (local_obl_x.lon >= 47.5 || local_obl_x.lat < 50.8 || local_obl_x.lat > 59.5)) continue;

          let local_r2 = local_obl_x.radius_km*local_obl_x.radius_km;
          let local_wsum = 0;
          let local_wz = 0;

          for (let y = 0; y < obl_list.length; y++) {
            if (x === y) continue;
            let local_obl_y = obl_list[y];
            let local_dot = Math.max(-1, Math.min(1, local_obl_x.ux*local_obl_y.ux + local_obl_x.uy*local_obl_y.uy + local_obl_x.uz*local_obl_y.uz));
            let local_d2 = earth_radius_km*earth_radius_km*Math.max(0, 2 - 2*local_dot);
            let local_w = local_obl_y.area_km2/(local_d2 + local_r2);

            local_wsum += local_w;
            local_wz += local_w*local_obl_means[y];
          }

          let local_nbr_prior = (local_wsum > 0) ? local_wz/local_wsum : local_obl_means[x];
          let local_cap_prior = (local_obl_x.id === 5319) ?
            Math.max(1.50*local_nbr_prior, 1.85*local_obl_x.all_z*local_per_ratio) :
            Math.max(local_nbr_prior, 0.85*local_obl_x.all_z*local_per_ratio);
          let local_trigger_ratio = (local_obl_x.id === 5319) ? 1.0 : 0.72;

          if (local_obl_means[x] < local_trigger_ratio*local_cap_prior) {
            let local_all_z_obl = Math.max(1e-6, local_obl_x.all_z);
            let local_floor_shape = (local_obl_x.id === 5319) ? 0.62 : 0.18;
            let local_mean_z_obl = Math.max(1e-6, local_obl_means[x]);
            let local_target_mean = (local_obl_x.id === 5319) ?
              (0.15*local_obl_means[x] + 0.85*local_cap_prior) :
              (0.45*local_obl_means[x] + 0.55*local_cap_prior);

            for (let y = 0; y < local_obl_x.raions.length; y++) {
              let local_r = local_obl_x.raions[y];
              let local_r_all_z = Math.sqrt(Math.max(0, (local_r.total_sites_all_periods || 0)/Math.max(1, local_r.effective_area_km2)));
              let local_z_raw = local_z[local_r._idx];
              let local_rel_shape = (local_obl_means[x] > 1e-6) ?
                (0.55*(local_z_raw/local_mean_z_obl) + 0.45*(local_r_all_z/local_all_z_obl)) :
                (local_r_all_z/local_all_z_obl);
              let local_z_new = Math.max(local_z_raw, local_target_mean*Math.max(local_floor_shape, local_rel_shape));

              local_r.eb_densities[local_pkey] = local_z_new*local_z_new;
            }
          }
        }
      }
    }


    /**
     * Loads adjacent Belarusian and Ukrainian ADM2 raions from sites_belarus_ukraine/geojson/*.geojson within 250 km of the Russian/Crimean land mask so the Kursk salient, Bryansk salient, Belgorod and northern Crimea have continuous cross-frontier conditioning points.
     * @alias SitesIARASObservationUtils.loadBelarusUkraineFrontierRaions
     *
     * @param {Object} arg0_mask_data
     * @param {Object} arg1_config
     *
     * @returns {Object}
     */
    static loadBelarusUkraineFrontierRaions (arg0_mask_data, arg1_config) {
      //Convert from parameters
      let mask_data = arg0_mask_data;
      let config = arg1_config;

      //Declare local instance variables
      let bu_dir = path.join(
        mask_data.project_root,
        "histmap/1.data_raw/population_regional/POLARIS/_shared/sites_belarus_ukraine/geojson"
      );
      let earth_radius_km = config.kriging_config.earth_radius_km;
      let max_dist_km = 250;
      let min_cos = Math.cos(max_dist_km/earth_radius_km);
      let period_configs = config.periods;
      let raion_map = new Map();
      let sample_ux = [];
      let sample_uy = [];
      let sample_uz = [];
      let unspec_map = new Map();

      //Guard clause if Belarus/Ukraine geojson folder is absent
      if (!fs.existsSync(bu_dir))
        return { raion_list: [], unspec_subregion_list: [] };

      for (let i = 0; i < mask_data.valid_cell_count; i++) {
        let local_gidx = mask_data.valid_indices[i];
        let local_lon = -180 + ((local_gidx % mask_data.grid_width) + 0.5)/12;
        let local_lat = 90 - (Math.floor(local_gidx/mask_data.grid_width) + 0.5)/12;

        if (local_lon < 43 && local_lat > 43 && local_lat < 58 && (i % 4 === 0)) {
          sample_ux.push(mask_data.cell_ux[i]);
          sample_uy.push(mask_data.cell_uy[i]);
          sample_uz.push(mask_data.cell_uz[i]);
        }
      }

      for (let i = 0; i < period_configs.length; i++) {
        let local_file = path.join(bu_dir, period_configs[i].geojson_filename);

        if (!fs.existsSync(local_file)) continue;

        let local_gj = JSON.parse(fs.readFileSync(local_file, "utf8"));
        let local_pkey = period_configs[i].key;

        for (let x = 0; x < local_gj.features.length; x++) {
          let local_coords = local_gj.features[x].geometry.coordinates;
          let local_lat = local_coords[1];
          let local_lon = local_coords[0];
          let local_props = local_gj.features[x].properties;

          //Exclude Kirovohrad (9118) and Donetsk (9124) raw kurgan registers from frontier conditioning
          if (local_props.oblast_id === 9118 || local_props.oblast_id === 9124) continue;

          let local_cos_lat = Math.cos(local_lat*Math.PI/180);
          let local_is_close = false;
          let local_key_id = `BU_${local_props.region_id}`;
          let local_lat_rad = local_lat*Math.PI/180;
          let local_lon_rad = local_lon*Math.PI/180;
          let local_target_map = (local_props.is_unspecified_subregion) ? unspec_map : raion_map;
          let local_ux = local_cos_lat*Math.cos(local_lon_rad);
          let local_uy = local_cos_lat*Math.sin(local_lon_rad);
          let local_uz = Math.sin(local_lat_rad);

          if (!local_target_map.has(local_key_id)) {
            for (let y = 0; y < sample_ux.length; y++)
              if (local_ux*sample_ux[y] + local_uy*sample_uy[y] + local_uz*sample_uz[y] >= min_cos) {
                local_is_close = true;
                break;
              }

            if (!local_is_close) continue;

            local_target_map.set(local_key_id, {
              eb_densities: {},
              id: local_key_id,
              is_frontier_buffer: true,
              lat: local_lat,
              lon: local_lon,
              name_ru: local_props.name_ru,
              oblast_id: local_props.oblast_id,
              oblast_name_ru: local_props.oblast_name_ru,
              periods: {},
              radius_km: 0,
              raw_periods: {},
              total_sites_all_periods: local_props.total_sites_all_periods || 0,
              ux: local_ux,
              uy: local_uy,
              uz: local_uz,
              voronoi_area_km2: 0
            });
          }

          let local_entry = local_target_map.get(local_key_id);

          if (local_entry) {
            local_entry.periods[local_pkey] = (local_entry.periods[local_pkey] || 0) + local_props.site_count;
            local_entry.raw_periods[local_pkey] = (local_entry.raw_periods[local_pkey] || 0) + local_props.site_count;
          }
        }
      }

      //Return statement
      return {
        raion_list: Array.from(raion_map.values()),
        unspec_subregion_list: Array.from(unspec_map.values())
      };
    }
  };
}

module.exports = global.SitesIARASObservationUtils;

