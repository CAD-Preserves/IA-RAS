//Import modules
let fs = require("fs");
let path = require("path");
let { PNG } = require("pngjs");

//Initialise functions
{
  /**
   * Low-level matrix algebra (Cholesky and Projected Gauss-Seidel Non-Negative Dual Kriging), separable 2D spatial box/partition filters, ray-casting polygon checks, HYDE 3.5 urban-settlement masking/inpainting and 4320x2160 float32 GeoPNG / Esri ASCII raster I/O utilities for the IA RAS (OANMAP) Residual Kriging pipeline.
   *
   * @class SitesIARASGridUtils
   */
  global.SitesIARASGridUtils = class {
    /**
     * Computes the lower-triangular Cholesky factor L of an N x N symmetric positive-definite matrix.
     * @alias SitesIARASGridUtils.computeCholeskyFactor
     *
     * @param {Float64Array} arg0_matrix
     * @param {number} arg1_n
     *
     * @returns {Float64Array}
     */
    static computeCholeskyFactor (arg0_matrix, arg1_n) {
      //Convert from parameters
      let matrix = arg0_matrix;
      let n = arg1_n;

      //Declare local instance variables
      let chol_L = new Float64Array(n*n);

      for (let i = 0; i < n; i++) {
        let local_row_i = i*n;

        for (let x = 0; x <= i; x++) {
          let local_row_x = x*n;
          let local_sum = matrix[local_row_i + x];

          for (let y = 0; y < x; y++)
            local_sum -= chol_L[local_row_i + y]*chol_L[local_row_x + y];

          if (i === x) {
            chol_L[local_row_i + i] = Math.sqrt(Math.max(1e-10, local_sum));
          } else {
            chol_L[local_row_i + x] = local_sum/chol_L[local_row_x + x];
          }
        }
      }

      //Return statement
      return chol_L;
    }


    /**
     * Computes summary and quantile statistics for a valid-mask float32 field.
     * @alias SitesIARASGridUtils.computeFieldQuantileStats
     *
     * @param {Float32Array} arg0_field
     * @param {string} arg1_filename
     * @param {number} arg2_total_sites_or_pop
     *
     * @returns {Object}
     */
    static computeFieldQuantileStats (arg0_field, arg1_filename, arg2_total_sites_or_pop) {
      //Convert from parameters
      let field = arg0_field;
      let filename = arg1_filename;
      let total_ref = arg2_total_sites_or_pop;

      //Declare local instance variables
      let getQ;
      let non_zero_vals = [];
      let sum = 0;

      for (let i = 0; i < field.length; i++) {
        let local_v = field[i];

        if (local_v > 1e-5) {
          non_zero_vals.push(local_v);
          sum += local_v;
        }
      }
      non_zero_vals.sort((a, b) => a - b);

      getQ = (arg0_q) => {
        if (non_zero_vals.length === 0) return 0;
        let local_idx = Math.floor(arg0_q*(non_zero_vals.length - 1));
        return Number(non_zero_vals[local_idx].toFixed(4));
      };

      //Return statement
      return {
        active_cells: non_zero_vals.length,
        filename: filename,
        max_value: getQ(1.0),
        mean_value: Number((sum/Math.max(1, field.length)).toFixed(4)),
        p10_value: getQ(0.10),
        p50_value: getQ(0.50),
        p90_value: getQ(0.90),
        p99_value: getQ(0.99),
        reference_total: total_ref,
        valid_mask_cells: field.length
      };
    }


    /**
     * Builds or retrieves the cached 1-pixel buffered modern urban settlement mask from HYDE 3.5 uopp_2023AD.png (uopp > 10,0 km2), matching GeoPNG.getModernUrbanMask in population_c14bazAAR.
     * @alias SitesIARASGridUtils.getModernUrbanMask
     *
     * @param {Object} arg0_mask_data
     * @param {Object} arg1_config
     * @param {Map} [arg2_cache]
     *
     * @returns {Uint8Array}
     */
    static getModernUrbanMask (arg0_mask_data, arg1_config, arg2_cache) {
      //Convert from parameters
      let mask_data = arg0_mask_data;
      let config = arg1_config;
      let cache = arg2_cache;

      //Guard clause if already cached
      if (cache && cache.has("__modern_urban_mask__")) return cache.get("__modern_urban_mask__");

      //Declare local instance variables
      let cov_paths = (config && config.kriging_config && config.kriging_config.covariate_paths) ?
        config.kriging_config.covariate_paths : {};
      let buffer_radius = (cov_paths.urban_mask_buffer_radius !== undefined) ?
        cov_paths.urban_mask_buffer_radius : 1;
      let dilated_mask;
      let grid_h = mask_data.grid_height;
      let grid_w = mask_data.grid_width;
      let raw_mask = new Uint8Array(mask_data.grid_width*mask_data.grid_height);
      let total_pixels = mask_data.grid_width*mask_data.grid_height;
      let uopp_grid;
      let uopp_path = path.join(
        mask_data.project_root,
        cov_paths.hyde_uopp_raster || "histmap/2.data_cleaning/landuse_HYDE/rasters/uopp_2023AD.png"
      );
      let uopp_threshold = (cov_paths.urban_uopp_threshold !== undefined) ? cov_paths.urban_uopp_threshold : 10.0;

      uopp_grid = this.readGlobalFloat32Raster(uopp_path, total_pixels);
      for (let i = 0; i < total_pixels; i++)
        if (uopp_grid[i] > uopp_threshold)
          raw_mask[i] = 1;

      if (buffer_radius <= 0) {
        if (cache) cache.set("__modern_urban_mask__", raw_mask);
        return raw_mask;
      }

      dilated_mask = new Uint8Array(total_pixels);
      for (let i = 0; i < grid_h; i++)
        for (let x = 0; x < grid_w; x++)
          if (raw_mask[i*grid_w + x] === 1)
            for (let y = -buffer_radius; y <= buffer_radius; y++) {
              let local_ny = i + y;

              if (local_ny >= 0 && local_ny < grid_h)
                for (let z = -buffer_radius; z <= buffer_radius; z++) {
                  let local_nx = (x + z + grid_w) % grid_w;

                  dilated_mask[local_ny*grid_w + local_nx] = 1;
                }
            }

      if (cache)
        cache.set("__modern_urban_mask__", dilated_mask);

      //Return statement
      return dilated_mask;
    }


    /**
     * Inpaints masked urban settlement pixels over habitable land using inverse-distance weighted (IDW) boundary interpolation from surrounding unmasked rural pixels, matching GeoPNG.inpaintUrbanMask in population_c14bazAAR.
     * @alias SitesIARASGridUtils.inpaintUrbanMaskGrid
     *
     * @param {Float32Array} arg0_popc_grid
     * @param {Uint8Array} arg1_urban_mask
     * @param {Float32Array} arg2_land_area_grid
     * @param {Float32Array} arg3_fallback_grid
     * @param {number} arg4_grid_width
     * @param {number} arg5_grid_height
     * @param {number} [arg6_inpaint_radius=3]
     * @param {Int32Array} [arg7_target_indices]
     *
     * @returns {Float32Array}
     */
    static inpaintUrbanMaskGrid (
      arg0_popc_grid,
      arg1_urban_mask,
      arg2_land_area_grid,
      arg3_fallback_grid,
      arg4_grid_width,
      arg5_grid_height,
      arg6_inpaint_radius,
      arg7_target_indices
    ) {
      //Convert from parameters
      let popc_grid = arg0_popc_grid;
      let urban_mask = arg1_urban_mask;
      let land_area_grid = arg2_land_area_grid;
      let fallback_grid = arg3_fallback_grid;
      let grid_w = arg4_grid_width;
      let grid_h = arg5_grid_height;
      let radius = (arg6_inpaint_radius !== undefined) ? arg6_inpaint_radius : 3;
      let target_indices = arg7_target_indices;

      //Declare local instance variables
      let n_targets = (target_indices) ? target_indices.length : grid_w*grid_h;
      let out_grid = new Float32Array(popc_grid);
      let wide_radius = radius*2;

      for (let i = 0; i < n_targets; i++) {
        let local_idx = (target_indices) ? target_indices[i] : i;

        if (urban_mask[local_idx] >= 1) {
          if (land_area_grid[local_idx] <= 0) {
            out_grid[local_idx] = 0;
            continue;
          }

          let local_cx = local_idx % grid_w;
          let local_cy = Math.floor(local_idx/grid_w);
          let local_pos_only = (urban_mask[local_idx] === 2);
          let local_val_sum = 0;
          let local_w_sum = 0;

          for (let x = -radius; x <= radius; x++) {
            let local_ny = local_cy + x;

            if (local_ny >= 0 && local_ny < grid_h)
              for (let y = -radius; y <= radius; y++) {
                if (x === 0 && y === 0) continue;

                let local_nx = (local_cx + y + grid_w) % grid_w;
                let local_nidx = local_ny*grid_w + local_nx;

                if (urban_mask[local_nidx] === 0 && land_area_grid[local_nidx] > 0 && (!local_pos_only || popc_grid[local_nidx] > 0)) {
                  let local_w = 1/Math.max(1, x*x + y*y);

                  local_val_sum += popc_grid[local_nidx]*local_w;
                  local_w_sum += local_w;
                }
              }
          }

          if (local_w_sum > 0) {
            out_grid[local_idx] = local_val_sum/local_w_sum;
          } else {
            for (let x = -wide_radius; x <= wide_radius; x++) {
              let local_ny = local_cy + x;

              if (local_ny >= 0 && local_ny < grid_h)
                for (let y = -wide_radius; y <= wide_radius; y++) {
                  let local_nx = (local_cx + y + grid_w) % grid_w;
                  let local_nidx = local_ny*grid_w + local_nx;

                  if (urban_mask[local_nidx] === 0 && land_area_grid[local_nidx] > 0 && (!local_pos_only || popc_grid[local_nidx] > 0)) {
                    let local_w = 1/Math.max(1, x*x + y*y);

                    local_val_sum += popc_grid[local_nidx]*local_w;
                    local_w_sum += local_w;
                  }
                }
            }

            if (local_w_sum > 0) {
              out_grid[local_idx] = local_val_sum/local_w_sum;
            } else if (popc_grid[local_idx] > 0 && fallback_grid && fallback_grid[local_idx] > 0) {
              out_grid[local_idx] = fallback_grid[local_idx];
            } else {
              out_grid[local_idx] = 0;
            }
          }
        }
      }

      //Return statement
      return out_grid;
    }


    /**
     * Checks whether a 5-arcminute cell (lon, lat) lies within the Crimea peninsula polygon or interior peninsula bounds.
     * @alias SitesIARASGridUtils.isCellInCrimea
     *
     * @param {number} arg0_lon
     * @param {number} arg1_lat
     * @param {Array<number[]>} arg2_crimea_ring
     * @param {Object} arg3_crimea_bbox
     *
     * @returns {boolean}
     */
    static isCellInCrimea (arg0_lon, arg1_lat, arg2_crimea_ring, arg3_crimea_bbox) {
      //Convert from parameters
      let lon = arg0_lon;
      let lat = arg1_lat;
      let crimea_ring = arg2_crimea_ring;
      let crimea_bbox = arg3_crimea_bbox;

      //Guard clause if outside Crimea bounding box
      if (
        lon < crimea_bbox.min_lon ||
        lon > crimea_bbox.max_lon ||
        lat < crimea_bbox.min_lat ||
        lat > crimea_bbox.max_lat
      ) return false;

      //Declare local instance variables
      let half_cell = 1/24;

      if (lat < crimea_bbox.peninsula_interior_max_lat) return true;
      if (
        this.isPointInPolygon(lon, lat, crimea_ring) ||
        this.isPointInPolygon(lon - half_cell, lat - half_cell, crimea_ring) ||
        this.isPointInPolygon(lon + half_cell, lat - half_cell, crimea_ring) ||
        this.isPointInPolygon(lon - half_cell, lat + half_cell, crimea_ring) ||
        this.isPointInPolygon(lon + half_cell, lat + half_cell, crimea_ring)
      ) return true;

      //Return statement
      return false;
    }


    /**
     * Ray-casting point-in-polygon check for a closed linear ring.
     * @alias SitesIARASGridUtils.isPointInPolygon
     *
     * @param {number} arg0_lon
     * @param {number} arg1_lat
     * @param {Array<number[]>} arg2_ring
     *
     * @returns {boolean}
     */
    static isPointInPolygon (arg0_lon, arg1_lat, arg2_ring) {
      //Convert from parameters
      let lon = arg0_lon;
      let lat = arg1_lat;
      let ring = arg2_ring;

      //Guard clause if ring is empty
      if (!ring || ring.length < 3) return false;

      //Declare local instance variables
      let is_inside = false;

      for (let i = 0, x = ring.length - 1; i < ring.length; x = i++) {
        let local_xi = ring[i][0];
        let local_xj = ring[x][0];
        let local_yi = ring[i][1];
        let local_yj = ring[x][1];

        if (
          ((local_yi > lat) !== (local_yj > lat)) &&
          (lon < (local_xj - local_xi)*(lat - local_yi)/(local_yj - local_yi + 1e-12) + local_xi)
        ) is_inside = !is_inside;
      }

      //Return statement
      return is_inside;
    }


    /**
     * Loads a single year's urban-masked HYDE 3.5 popc float32 raster over the valid Russia (excl. Kaliningrad) + Crimea mask.
     * @alias SitesIARASGridUtils.loadSingleSubstrataRaster
     *
     * @param {Object} arg0_mask_data
     * @param {number} arg1_year
     * @param {Map} [arg2_cache]
     * @param {Object} [arg3_config]
     *
     * @returns {Float32Array}
     */
    static loadSingleSubstrataRaster (arg0_mask_data, arg1_year, arg2_cache, arg3_config) {
      //Convert from parameters
      let mask_data = arg0_mask_data;
      let year = arg1_year;
      let cache = arg2_cache;
      let config = arg3_config;

      //Return statement
      return this.loadUrbanMaskedHYDEPopcRaster(mask_data, year, cache, config);
    }


    /**
     * Loads HYDE 3.5's popc raster for a given benchmark year and masks + inpaints modern and historical urban settlements and interior reservoir/exclusion zero-holes using the population_c14bazAAR methodology (uopp_2023AD > 10,0 km2 buffered by 1px + urbc > 0 + 8x isolated spike removal + IDW boundary inpainting).
     * @alias SitesIARASGridUtils.loadUrbanMaskedHYDEPopcRaster
     *
     * @param {Object} arg0_mask_data
     * @param {number} arg1_year
     * @param {Map} [arg2_cache]
     * @param {Object} [arg3_config]
     *
     * @returns {Float32Array}
     */
    static loadUrbanMaskedHYDEPopcRaster (arg0_mask_data, arg1_year, arg2_cache, arg3_config) {
      //Convert from parameters
      let mask_data = arg0_mask_data;
      let year = arg1_year;
      let cache = arg2_cache;
      let config = arg3_config;

      //Declare local instance variables
      let cache_key = `hyde_urban_masked_${year}`;
      let cleaned_grid;
      let cov_paths;
      let grid_h = mask_data.grid_height;
      let grid_w = mask_data.grid_width;
      let inpaint_radius = 4;
      let kk10_grid = null;
      let kk10_path;
      let land_area_grid = mask_data.land_area_grid;
      let modern_urban_mask;
      let n_valid = mask_data.valid_cell_count;
      let out_arr;
      let popc_grid;
      let popc_path;
      let root = mask_data.project_root;
      let spike_ratio = 8.0;
      let total_pixels = mask_data.grid_width*mask_data.grid_height;
      let urbc_grid;
      let urbc_path;
      let valid_indices = mask_data.valid_indices;
      let year_label = (year < 0) ? `${Math.abs(year)}BC` : `${year}AD`;
      let year_urban_mask;

      //Guard clause if already cached
      if (cache && cache.has(cache_key)) return cache.get(cache_key);

      if (!config && global.SitesIARASKriging)
        config = global.SitesIARASKriging.loadConfig();

      cov_paths = (config && config.kriging_config && config.kriging_config.covariate_paths) ?
        config.kriging_config.covariate_paths : {};
      if (cov_paths.urban_mask_inpaint_radius !== undefined)
        inpaint_radius = cov_paths.urban_mask_inpaint_radius;
      if (cov_paths.urban_outlier_spike_ratio !== undefined)
        spike_ratio = cov_paths.urban_outlier_spike_ratio;

      popc_path = path.join(
        root,
        cov_paths.hyde_popc_folder || "histmap/2.data_cleaning/landuse_HYDE/rasters_scaled_to_global",
        `popc_${year}.png`
      );
      if (!fs.existsSync(popc_path))
        popc_path = path.join(
          root,
          cov_paths.hyde_raw_rasters_folder || "histmap/2.data_cleaning/landuse_HYDE/rasters",
          `popc_${year_label}.png`
        );

      popc_grid = this.readGlobalFloat32Raster(popc_path, total_pixels);
      modern_urban_mask = this.getModernUrbanMask(mask_data, config, cache);
      year_urban_mask = new Uint8Array(modern_urban_mask);

      //1. Union historical HYDE urbc_<year>.png > 0
      urbc_path = path.join(
        root,
        cov_paths.hyde_mcevedy_rasters_folder || "histmap/2.data_cleaning/landuse_HYDE/rasters_mcevedy",
        `urbc_${year}.png`
      );
      if (!fs.existsSync(urbc_path))
        urbc_path = path.join(
          root,
          cov_paths.hyde_raw_rasters_folder || "histmap/2.data_cleaning/landuse_HYDE/rasters",
          `urbc_${year_label}.png`
        );

      if (fs.existsSync(urbc_path)) {
        urbc_grid = this.readGlobalFloat32Raster(urbc_path, total_pixels);
        for (let i = 0; i < total_pixels; i++)
          if (urbc_grid[i] > 0)
            year_urban_mask[i] = 1;
      }

      //2. Union Soviet hydroelectric reservoir holes inside settled European Russian river valleys and isolated single-pixel modern/urban outlier spikes (> 8x positive 3x3 Moore rural neighbourhood mean)
      for (let i = 0; i < n_valid; i++) {
        let local_gidx = valid_indices[i];

        if (land_area_grid[local_gidx] > 0 && popc_grid[local_gidx] <= 0) {
          let local_cx = local_gidx % grid_w;
          let local_cy = Math.floor(local_gidx/grid_w);
          let local_lat = 90 - (local_cy + 0.5)/12;
          let local_lon = -180 + (local_cx + 0.5)/12;

          if (local_lat >= 44.0 && local_lat <= 60.5 && local_lon >= 27.0 && local_lon <= 57.0) {
            let local_land_cnt = 0;
            let local_pos_area = 0;
            let local_pos_cnt = 0;
            let local_pos_sum = 0;

            for (let x = -4; x <= 4; x++) {
              let local_ny = local_cy + x;

              if (local_ny >= 0 && local_ny < grid_h)
                for (let y = -4; y <= 4; y++) {
                  if (x === 0 && y === 0) continue;

                  let local_nx = (local_cx + y + grid_w) % grid_w;
                  let local_nidx = local_ny*grid_w + local_nx;

                  if (land_area_grid[local_nidx] > 0) {
                    local_land_cnt++;
                    if (popc_grid[local_nidx] > 0) {
                      local_pos_cnt++;
                      local_pos_sum += popc_grid[local_nidx];
                      local_pos_area += land_area_grid[local_nidx];
                    }
                  }
                }
            }

            if (local_land_cnt > 0 && (local_pos_cnt/local_land_cnt) >= 0.55 && (local_pos_sum/Math.max(1, local_pos_area)) >= 0.12)
              year_urban_mask[local_gidx] = 2;
          }
          continue;
        }
        if (year_urban_mask[local_gidx] >= 1 || popc_grid[local_gidx] <= 0) continue;

        let local_cx = local_gidx % grid_w;
        let local_cy = Math.floor(local_gidx/grid_w);
        let local_ncnt = 0;
        let local_nsum = 0;

        for (let x = -1; x <= 1; x++) {
          let local_ny = local_cy + x;

          if (local_ny >= 0 && local_ny < grid_h)
            for (let y = -1; y <= 1; y++) {
              if (x === 0 && y === 0) continue;

              let local_nx = (local_cx + y + grid_w) % grid_w;
              let local_nidx = local_ny*grid_w + local_nx;

              if (year_urban_mask[local_nidx] === 0 && land_area_grid[local_nidx] > 0 && popc_grid[local_nidx] > 0) {
                local_nsum += popc_grid[local_nidx];
                local_ncnt++;
              }
            }
        }

        if (local_ncnt >= 3 && popc_grid[local_gidx] > spike_ratio*(local_nsum/local_ncnt))
          year_urban_mask[local_gidx] = 1;
      }

      //3. Load KK10LUH2 fallback only for deep multi-pixel urban cores if needed
      kk10_path = path.join(
        root,
        cov_paths.kk10_fallback_folder || "histmap/2.data_cleaning/population_KK10LUH2/rasters_KK10LUH2_2._global_scaling",
        `popc_${year}.png`
      );
      if (fs.existsSync(kk10_path))
        kk10_grid = this.readGlobalFloat32Raster(kk10_path, total_pixels);

      cleaned_grid = this.inpaintUrbanMaskGrid(
        popc_grid,
        year_urban_mask,
        land_area_grid,
        kk10_grid,
        grid_w,
        grid_h,
        inpaint_radius,
        valid_indices
      );

      out_arr = new Float32Array(n_valid);
      for (let i = 0; i < n_valid; i++) {
        let local_val = cleaned_grid[valid_indices[i]];

        if (!isNaN(local_val) && isFinite(local_val) && local_val > 0)
          out_arr[i] = local_val;
      }

      if (cache)
        cache.set(cache_key, out_arr);

      //Return statement
      return out_arr;
    }


    /**
     * Reads a 4320x2160 big-endian float32 GeoPNG file directly into a valid-mask Float32Array.
     * @alias SitesIARASGridUtils.loadValidFloat32Raster
     *
     * @param {Object} arg0_mask_data
     * @param {string} arg1_file_path
     *
     * @returns {Float32Array}
     */
    static loadValidFloat32Raster (arg0_mask_data, arg1_file_path) {
      //Convert from parameters
      let mask_data = arg0_mask_data;
      let file_path = arg1_file_path;

      //Declare local instance variables
      let data_view;
      let n_valid = mask_data.valid_cell_count;
      let out_arr = new Float32Array(mask_data.valid_cell_count);
      let png_data = PNG.sync.read(fs.readFileSync(file_path)).data;
      let valid_indices = mask_data.valid_indices;

      data_view = new DataView(png_data.buffer, png_data.byteOffset, png_data.byteLength);

      for (let i = 0; i < n_valid; i++) {
        let local_px = valid_indices[i]*4;

        if (
          png_data[local_px] === 0 &&
          png_data[local_px + 1] === 0 &&
          png_data[local_px + 2] === 0 &&
          png_data[local_px + 3] === 0
        ) continue;

        let local_val = data_view.getFloat32(local_px, false);

        if (!isNaN(local_val) && isFinite(local_val) && local_val > 0)
          out_arr[i] = local_val;
      }

      //Return statement
      return out_arr;
    }


    /**
     * Reads a 6-header-line Esri ASCII raster (.asc) into a flat Float32Array.
     * @alias SitesIARASGridUtils.readAscGrid
     *
     * @param {string} arg0_file_path
     * @param {number} arg1_total_pixels
     *
     * @returns {Float32Array}
     */
    static readAscGrid (arg0_file_path, arg1_total_pixels) {
      //Convert from parameters
      let file_path = arg0_file_path;
      let total_pixels = arg1_total_pixels;

      //Declare local instance variables
      let out_grid = new Float32Array(total_pixels);
      let tokens = fs.readFileSync(file_path, "utf8").trim().split(/\s+/);

      for (let i = 0; i < total_pixels; i++)
        out_grid[i] = parseFloat(tokens[12 + i]);

      //Return statement
      return out_grid;
    }


    /**
     * Reads a full 4320x2160 big-endian float32 GeoPNG file into a flat Float32Array.
     * @alias SitesIARASGridUtils.readGlobalFloat32Raster
     *
     * @param {string} arg0_file_path
     * @param {number} arg1_total_pixels
     *
     * @returns {Float32Array}
     */
    static readGlobalFloat32Raster (arg0_file_path, arg1_total_pixels) {
      //Convert from parameters
      let file_path = arg0_file_path;
      let total_pixels = arg1_total_pixels;

      //Declare local instance variables
      let data_view;
      let out_grid = new Float32Array(total_pixels);
      let png_data = PNG.sync.read(fs.readFileSync(file_path)).data;

      data_view = new DataView(png_data.buffer, png_data.byteOffset, png_data.byteLength);

      for (let i = 0; i < total_pixels; i++) {
        let local_px = i*4;

        if (
          png_data[local_px] === 0 &&
          png_data[local_px + 1] === 0 &&
          png_data[local_px + 2] === 0 &&
          png_data[local_px + 3] === 0
        ) continue;

        let local_val = data_view.getFloat32(local_px, false);

        if (!isNaN(local_val) && isFinite(local_val) && local_val > 0)
          out_grid[i] = local_val;
      }

      //Return statement
      return out_grid;
    }


    /**
     * Smooths a valid-cell array over positive cells (field[i] > 0) using an exact two-pass separable 2D box window filter.
     * @alias SitesIARASGridUtils.smoothPositiveFieldOnGrid
     *
     * @param {Object} arg0_mask_data
     * @param {Float32Array} arg1_valid_field
     * @param {number} arg2_radius_px
     *
     * @returns {Float32Array}
     */
    static smoothPositiveFieldOnGrid (arg0_mask_data, arg1_valid_field, arg2_radius_px) {
      //Convert from parameters
      let mask_data = arg0_mask_data;
      let valid_field = arg1_valid_field;
      let radius_px = arg2_radius_px;

      //Declare local instance variables
      let grid_h = mask_data.grid_height;
      let grid_w = mask_data.grid_width;
      let horiz_cnt = new Int32Array(mask_data.valid_cell_count);
      let horiz_sum = new Float32Array(mask_data.valid_cell_count);
      let n_valid = mask_data.valid_cell_count;
      let out_pass = new Float32Array(mask_data.valid_cell_count);
      let px_to_valid = mask_data.pixel_to_valid_idx;
      let valid_indices = mask_data.valid_indices;

      for (let i = 0; i < n_valid; i++) {
        if (valid_field[i] <= 0) continue;

        let local_cnt = 0;
        let local_cx = valid_indices[i] % grid_w;
        let local_row = Math.floor(valid_indices[i]/grid_w)*grid_w;
        let local_sum = 0;
        let local_x0 = Math.max(0, local_cx - radius_px);
        let local_x1 = Math.min(grid_w - 1, local_cx + radius_px);

        for (let x = local_x0; x <= local_x1; x++) {
          let local_v_idx = px_to_valid[local_row + x];

          if (local_v_idx >= 0 && valid_field[local_v_idx] > 0) {
            local_sum += valid_field[local_v_idx];
            local_cnt++;
          }
        }
        horiz_cnt[i] = local_cnt;
        horiz_sum[i] = local_sum;
      }

      for (let i = 0; i < n_valid; i++) {
        if (valid_field[i] <= 0) continue;

        let local_cnt = 0;
        let local_cx = valid_indices[i] % grid_w;
        let local_cy = Math.floor(valid_indices[i]/grid_w);
        let local_sum = 0;
        let local_y0 = Math.max(0, local_cy - radius_px);
        let local_y1 = Math.min(grid_h - 1, local_cy + radius_px);

        for (let y = local_y0; y <= local_y1; y++) {
          let local_v_idx = px_to_valid[y*grid_w + local_cx];

          if (local_v_idx >= 0 && horiz_cnt[local_v_idx] > 0) {
            local_sum += horiz_sum[local_v_idx];
            local_cnt += horiz_cnt[local_v_idx];
          }
        }
        out_pass[i] = (local_cnt > 0) ? local_sum/local_cnt : valid_field[i];
      }

      //Return statement
      return out_pass;
    }


    /**
     * Smooths a valid-cell array over the 2D 4320x2160 mask using a two-pass separable box window filter.
     * @alias SitesIARASGridUtils.smoothValidFieldOnGrid
     *
     * @param {Object} arg0_mask_data
     * @param {Float32Array} arg1_valid_field
     * @param {number} arg2_radius_px
     *
     * @returns {Float32Array}
     */
    static smoothValidFieldOnGrid (arg0_mask_data, arg1_valid_field, arg2_radius_px) {
      //Convert from parameters
      let mask_data = arg0_mask_data;
      let valid_field = arg1_valid_field;
      let radius_px = arg2_radius_px;

      //Declare local instance variables
      let grid_h = mask_data.grid_height;
      let grid_w = mask_data.grid_width;
      let horiz_pass = new Float32Array(mask_data.valid_cell_count);
      let n_valid = mask_data.valid_cell_count;
      let out_pass = new Float32Array(mask_data.valid_cell_count);
      let px_to_valid = mask_data.pixel_to_valid_idx;
      let valid_indices = mask_data.valid_indices;

      for (let i = 0; i < n_valid; i++) {
        let local_cnt = 0;
        let local_idx = valid_indices[i];
        let local_row = Math.floor(local_idx/grid_w)*grid_w;
        let local_sum = 0;
        let local_x = local_idx % grid_w;

        for (let x = -radius_px; x <= radius_px; x++) {
          let local_nx = (local_x + x + grid_w) % grid_w;
          let local_v_idx = px_to_valid[local_row + local_nx];

          if (local_v_idx >= 0) {
            local_sum += valid_field[local_v_idx];
            local_cnt++;
          }
        }
        horiz_pass[i] = (local_cnt > 0) ? local_sum/local_cnt : valid_field[i];
      }

      for (let i = 0; i < n_valid; i++) {
        let local_cnt = 0;
        let local_idx = valid_indices[i];
        let local_sum = 0;
        let local_x = local_idx % grid_w;
        let local_y = Math.floor(local_idx/grid_w);

        for (let y = -radius_px; y <= radius_px; y++) {
          let local_ny = local_y + y;

          if (local_ny >= 0 && local_ny < grid_h) {
            let local_v_idx = px_to_valid[local_ny*grid_w + local_x];

            if (local_v_idx >= 0) {
              local_sum += horiz_pass[local_v_idx];
              local_cnt++;
            }
          }
        }
        out_pass[i] = (local_cnt > 0) ? local_sum/local_cnt : horiz_pass[i];
      }

      //Return statement
      return out_pass;
    }


    /**
     * Normalises a positive valid-cell field by its within-partition local positive mean using an exact two-pass separable box filter, eliminating administrative scaling cliffs while preserving 100% of natural topographic and river-valley boundaries.
     * @alias SitesIARASGridUtils.smoothWithinPartitionPositive
     *
     * @param {Object} arg0_mask_data
     * @param {Float32Array} arg1_valid_field
     * @param {Int32Array} arg2_part_id
     * @param {Float64Array} arg3_part_sum
     * @param {Int32Array} arg4_part_cnt
     * @param {number} arg5_radius_px
     *
     * @returns {Float32Array}
     */
    static smoothWithinPartitionPositive (
      arg0_mask_data,
      arg1_valid_field,
      arg2_part_id,
      arg3_part_sum,
      arg4_part_cnt,
      arg5_radius_px
    ) {
      //Convert from parameters
      let mask_data = arg0_mask_data;
      let valid_field = arg1_valid_field;
      let part_id = arg2_part_id;
      let part_sum = arg3_part_sum;
      let part_cnt = arg4_part_cnt;
      let radius_px = arg5_radius_px;

      //Declare local instance variables
      let grid_h = mask_data.grid_height;
      let grid_w = mask_data.grid_width;
      let horiz_cnt = new Int32Array(mask_data.valid_cell_count);
      let horiz_sum = new Float32Array(mask_data.valid_cell_count);
      let n_valid = mask_data.valid_cell_count;
      let out_pass = new Float32Array(mask_data.valid_cell_count);
      let px_to_valid = mask_data.pixel_to_valid_idx;
      let valid_indices = mask_data.valid_indices;

      for (let i = 0; i < n_valid; i++) {
        if (valid_field[i] <= 0) continue;

        let local_cnt = 0;
        let local_cx = valid_indices[i] % grid_w;
        let local_pid = part_id[i];
        let local_row = Math.floor(valid_indices[i]/grid_w)*grid_w;
        let local_sum = 0;
        let local_x0 = Math.max(0, local_cx - radius_px);
        let local_x1 = Math.min(grid_w - 1, local_cx + radius_px);

        for (let x = local_x0; x <= local_x1; x++) {
          let local_v_idx = px_to_valid[local_row + x];

          if (local_v_idx >= 0 && part_id[local_v_idx] === local_pid && valid_field[local_v_idx] > 0) {
            local_sum += valid_field[local_v_idx];
            local_cnt++;
          }
        }
        horiz_cnt[i] = local_cnt;
        horiz_sum[i] = local_sum;
      }

      for (let i = 0; i < n_valid; i++) {
        if (valid_field[i] <= 0) continue;

        let local_cnt = 0;
        let local_cx = valid_indices[i] % grid_w;
        let local_cy = Math.floor(valid_indices[i]/grid_w);
        let local_pid = part_id[i];
        let local_ref_mean;
        let local_sum = 0;
        let local_y0 = Math.max(0, local_cy - radius_px);
        let local_y1 = Math.min(grid_h - 1, local_cy + radius_px);

        for (let y = local_y0; y <= local_y1; y++) {
          let local_v_idx = px_to_valid[y*grid_w + local_cx];

          if (local_v_idx >= 0 && part_id[local_v_idx] === local_pid && horiz_cnt[local_v_idx] > 0) {
            local_sum += horiz_sum[local_v_idx];
            local_cnt += horiz_cnt[local_v_idx];
          }
        }

        if (local_cnt >= 4) {
          local_ref_mean = local_sum/local_cnt;
        } else if (part_cnt[local_pid] > 0) {
          local_ref_mean = part_sum[local_pid]/part_cnt[local_pid];
        } else {
          local_ref_mean = 1;
        }

        out_pass[i] = valid_field[i]/Math.max(1e-6, local_ref_mean);
      }

      //Return statement
      return out_pass;
    }


    /**
     * Solves a lower-triangular Cholesky system L*L^T * x = b.
     * @alias SitesIARASGridUtils.solveCholeskyVector
     *
     * @param {Float64Array} arg0_chol_L
     * @param {Float64Array} arg1_rhs
     * @param {number} arg2_n
     *
     * @returns {Float64Array}
     */
    static solveCholeskyVector (arg0_chol_L, arg1_rhs, arg2_n) {
      //Convert from parameters
      let chol_L = arg0_chol_L;
      let rhs = arg1_rhs;
      let n = arg2_n;

      //Declare local instance variables
      let sol_x = new Float64Array(n);
      let sol_y = new Float64Array(n);

      for (let i = 0; i < n; i++) {
        let local_row = i*n;
        let local_sum = rhs[i];

        for (let x = 0; x < i; x++)
          local_sum -= chol_L[local_row + x]*sol_y[x];
        sol_y[i] = local_sum/chol_L[local_row + i];
      }

      for (let i = n - 1; i >= 0; i--) {
        let local_sum = sol_y[i];

        for (let x = i + 1; x < n; x++)
          local_sum -= chol_L[x*n + i]*sol_x[x];
        sol_x[i] = local_sum/chol_L[i*n + i];
      }

      //Return statement
      return sol_x;
    }


    /**
     * Solves the symmetric positive-definite Dual Kriging system (C + eta*I) * w = z_adj subject to non-negativity (w >= 0) via Cholesky warm-start followed by Projected Gauss-Seidel sweeps.
     * @alias SitesIARASGridUtils.solveNonNegativeDualKriging
     *
     * @param {Float64Array} arg0_cov_matrix
     * @param {Float64Array} arg1_chol_L
     * @param {Float64Array} arg2_z_adj
     * @param {number} arg3_n_raions
     *
     * @returns {Float32Array}
     */
    static solveNonNegativeDualKriging (arg0_cov_matrix, arg1_chol_L, arg2_z_adj, arg3_n_raions) {
      //Convert from parameters
      let cov_matrix = arg0_cov_matrix;
      let chol_L = arg1_chol_L;
      let z_adj = arg2_z_adj;
      let n_raions = arg3_n_raions;

      //Declare local instance variables
      let out_w = new Float32Array(n_raions);
      let v_vec = this.solveCholeskyVector(chol_L, z_adj, n_raions);
      let w_vec = new Float64Array(n_raions);

      for (let i = 0; i < n_raions; i++)
        w_vec[i] = Math.max(0, v_vec[i]);

      for (let i = 0; i < 60; i++)
        for (let x = 0; x < n_raions; x++) {
          let local_diag = cov_matrix[x*n_raions + x];
          let local_rhs = z_adj[x];
          let local_row = x*n_raions;

          for (let y = 0; y < n_raions; y++)
            if (y !== x && w_vec[y] > 0)
              local_rhs -= cov_matrix[local_row + y]*w_vec[y];

          w_vec[x] = (local_diag > 1e-12) ? Math.max(0, local_rhs/local_diag) : 0;
        }

      for (let i = 0; i < n_raions; i++)
        out_w[i] = w_vec[i];

      //Return statement
      return out_w;
    }


    /**
     * Writes a 4320x2160 float32 GeoPNG raster with values populated only on the valid Russia (excl. Kaliningrad) + Crimea land mask and exact 0,0 elsewhere.
     * @alias SitesIARASGridUtils.writeMaskedFloat32GeoPNG
     *
     * @param {string} arg0_file_path
     * @param {Object} arg1_mask_data
     * @param {Float32Array} arg2_valid_values
     * @param {Object} [arg3_options]
     *
     * @returns {string}
     */
    static writeMaskedFloat32GeoPNG (arg0_file_path, arg1_mask_data, arg2_valid_values, arg3_options) {
      //Convert from parameters
      let file_path = arg0_file_path;
      let mask_data = arg1_mask_data;
      let valid_values = arg2_valid_values;
      let options = (arg3_options) ? arg3_options : {};

      //Declare local instance variables
      let buffer;
      let compression_level = (options.png_compression_level !== undefined) ? options.png_compression_level : 6;
      let float_buf = new ArrayBuffer(4);
      let float_view = new DataView(float_buf);
      let n_valid = mask_data.valid_cell_count;
      let png_image = new PNG({
        colorType: 6,
        height: mask_data.grid_height,
        width: mask_data.grid_width
      });
      let valid_indices = mask_data.valid_indices;

      for (let i = 0; i < n_valid; i++) {
        let local_px = valid_indices[i]*4;
        let local_val = valid_values[i];

        if (local_val > 1e-6 && !isNaN(local_val) && isFinite(local_val)) {
          float_view.setFloat32(0, local_val, false);
          png_image.data[local_px] = float_view.getUint8(0);
          png_image.data[local_px + 1] = float_view.getUint8(1);
          png_image.data[local_px + 2] = float_view.getUint8(2);
          png_image.data[local_px + 3] = float_view.getUint8(3);
        }
      }

      buffer = PNG.sync.write(png_image, {
        colorType: 6,
        deflateLevel: compression_level
      });
      fs.writeFileSync(file_path, buffer);

      //Return statement
      return file_path;
    }
  };
}

module.exports = global.SitesIARASGridUtils;
