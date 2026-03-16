/**
 * Sydney Buses Live — frontend entry point.
 *
 * Fetches real-time bus positions from the REST API every REFRESH_MS
 * milliseconds, creates or updates Leaflet markers for each vehicle,
 * and animates their movement and rotation on the map.
 *
 * Data flow:
 *   API Gateway → Lambda (reads S3 latest.json) → this client
 *
 * The NSW GTFS-RT feed updates approximately every 10 seconds, so
 * REFRESH_MS is set to match that cadence.
 */
document.addEventListener("DOMContentLoaded", () => {

  // ─── Configuration ────────────────────────────────────────────────────────

  /** REST endpoint returning the latest bus snapshot (JSON). */
  const API_URL =
    "https://px97vg8cc5.execute-api.ap-southeast-2.amazonaws.com/buses/latest";

  /** How often (ms) to poll the API. */
  const REFRESH_MS = 3000;

  /**
   * How long (ms) to animate a bus moving to its new GPS position.
   * Set just under REFRESH_MS so the bus arrives right before the next update,
   * giving the impression of continuous movement.
   */
  const MOVE_DURATION = 5000;

  /** How long (ms) to animate a bus rotating to its new bearing before moving. */
  const ROTATE_DURATION = 300;

  // ─── Route colour ─────────────────────────────────────────────────────────

  /**
   * Fixed colour per route. Each route always renders with the same colour
   * regardless of timing or what other routes are active.
   * Unknown routes fall back to grey.
   */
  const ROUTE_COLORS = {
    "313":  "#2563eb", // blue
    "333":  "#16a34a", // green
    "350":  "#dc2626", // red
    "360":  "#0d9488", // teal
    "362":  "#db2777", // rose
    "370":  "#f59e0b", // amber
    "373":  "#9333ea", // purple
    "379":  "#0891b2", // cyan
    "380":  "#65a30d", // lime
    "390X": "#ea580c", // orange
    "726e": "#6366f1", // indigo
  };

  /**
   * Return the colour assigned to a route.
   *
   * @param {string} routeId - Route short name (e.g. "370").
   * @returns {string} Hex colour string.
   */
  function getRouteColor(routeId = "") {
    return ROUTE_COLORS[String(routeId)] ?? "#6b7280";
  }

  // ─── Map initialisation ───────────────────────────────────────────────────

  /**
   * Geographic bounding box for the Eastern Suburbs of Sydney.
   * The map is constrained to this area so users cannot pan away.
   */
  const EASTERN_SUBURBS_BOUNDS = L.latLngBounds(
    [-33.985, 151.170],
    [-33.840, 151.310]
  );

  const map = L.map("map", {
    zoomControl: false,          // zoom control added manually (topright)
    maxBounds: EASTERN_SUBURBS_BOUNDS,
    maxBoundsViscosity: 0.85,    // soft boundary — map resists but doesn't snap
  });

  // Fallback view in case the ResizeObserver below fires very late.
  map.setView([-33.912, 151.240], 14);

  // Chrome (HTTP/2 + HTTPS) can fire DOMContentLoaded before the flex
  // layout has calculated #map's height, so Leaflet initialises with a
  // zero-height container and picks the wrong zoom.  A ResizeObserver
  // fires as soon as the element gets its real pixel dimensions —
  // regardless of whether that happens before or after CSS is parsed —
  // which is more reliable than window.load or setTimeout across browsers.
  const mapEl = document.getElementById("map");
  const ro = new ResizeObserver(() => {
    if (mapEl.offsetHeight > 0) {
      ro.disconnect();                            // one-shot, only initial sizing
      map.invalidateSize({ reset: true });
      map.setView([-33.912, 151.240], 14, { animate: false });
    }
  });
  ro.observe(mapEl);

  L.control.zoom({ position: "topright" }).addTo(map);

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: "OpenStreetMap",
  }).addTo(map);

  // ─── Legend ───────────────────────────────────────────────────────────────

  /** Leaflet control that renders the route colour legend (bottom-left). */
  const legend = L.control({ position: "bottomleft" });

  /** Called by Leaflet when the control is added to the map. */
  legend.onAdd = function () {
    this._div = L.DomUtil.create("div", "bus-legend");
    return this._div;
  };

  /**
   * Rebuild the legend HTML from the current sorted list of route names.
   *
   * @param {string[]} routes - Sorted array of route short names.
   */
  legend.update = function (routes) {
    if (!this._div) return;

    let html = "<strong>Routes</strong>";

    for (const route of routes) {
      const color = getRouteColor(route);
      html += `
        <div class="legend-row">
          <span class="legend-color" style="background:${color}"></span>
          <span>${route}</span>
        </div>
      `;
    }

    this._div.innerHTML = html;
  };

  legend.addTo(map);

  // ─── State ────────────────────────────────────────────────────────────────

  const routeSelect = document.getElementById("route-select");

  /**
   * Live bus registry.
   * Keys are vehicle IDs (strings); values are bus state objects:
   *   { marker, last, angle, hasDirection, routeId, directionId, vehicleId, tripId,
   *     _cancelRotation, _cancelMove }
   */
  const buses = {};

  /** Currently selected route filter. "all" means no filter. */
  let selectedRoute = "all";

  /** Set of route short names seen in the most recent successful fetch. */
  let availableRoutes = new Set();

  /**
   * Last zoom bucket used to resize icons.
   * We only rebuild icons when the bucket changes (not on every zoom step).
   */
  let lastZoomBucket = getZoomBucket();

  // Show/hide legend and update markers when the user picks a route.
  routeSelect.addEventListener("change", (e) => {
    selectedRoute = e.target.value;
    applyRouteFilter();
    updateLegendVisibility();
  });

  // ─── UI helpers ───────────────────────────────────────────────────────────

  /**
   * Hide the legend when a specific route is selected (it's redundant then),
   * and show it again when "all routes" is selected.
   */
  function updateLegendVisibility() {
    const legendEl = document.querySelector(".bus-legend");
    if (!legendEl) return;
    legendEl.style.display = selectedRoute === "all" ? "block" : "none";
  }

  // ─── Zoom-based icon sizing ───────────────────────────────────────────────

  /**
   * Map the current zoom level to a discrete size bucket (0–4).
   * This avoids rebuilding all icons on every individual zoom step.
   *
   * @returns {number} Bucket index 0 (smallest) to 4 (largest).
   */
  function getZoomBucket() {
    const z = map.getZoom();
    if (z >= 16) return 4;
    if (z >= 15) return 3;
    if (z >= 14) return 2;
    if (z >= 13) return 1;
    return 0;
  }

  /**
   * Return the pixel width and height for bus icons at the current zoom level.
   * The bus is kept narrow so overlapping vehicles on the same road are visible.
   *
   * @returns {{ width: number, height: number }}
   */
  function getBusDimensions() {
    switch (getZoomBucket()) {
      case 4:
        return { width: 18, height: 50 };
      case 3:
        return { width: 15, height: 44 };
      case 2:
        return { width: 13, height: 40 };
      case 1:
        return { width: 12, height: 34 };
      default:
        return { width: 10, height: 28 };
    }
  }

  // ─── Bus icon ─────────────────────────────────────────────────────────────

  /**
   * Build the HTML string for a bus marker icon.
   *
   * The SVG contains no hardcoded colour or rotation — those are applied
   * separately via CSS custom properties and inline transforms on the DOM
   * element, so the icon HTML can be shared across all buses at a given
   * zoom level without rebuilding it per vehicle.
   *
   * SVG coordinate system: viewBox "0 -18 100 168".
   *   - The triangle (arrow) points upward (north) at angle 0.
   *   - Rotation is applied externally on .bus-wrap.
   *   - Colour is set via --bus-color on the parent Leaflet element.
   *
   * @param {number} width  - Icon width in pixels.
   * @param {number} height - Icon height in pixels.
   * @returns {string} HTML string for the icon.
   */
  function buildBusSvg(width, height) {
    return `
      <div
        class="bus-wrap"
        style="--bus-width:${width}px; --bus-height:${height}px;"
      >
        <svg viewBox="0 -18 100 168" class="bus-svg">
          <!-- Direction arrow — points toward the front of the bus -->
          <polygon
            class="bus-arrow"
            points="50,-42 18,14 82,14"
            fill="var(--bus-color)"
            stroke="white"
            stroke-width="3"
            stroke-linejoin="round"
            visibility="hidden"
          />

          <!-- Drop shadow for the bus body -->
          <rect
            x="14"
            y="10"
            rx="16"
            ry="16"
            width="72"
            height="130"
            class="bus-shadow"
            transform="translate(2,2)"
          />

          <!-- Bus body -->
          <rect
            x="14"
            y="10"
            rx="16"
            ry="16"
            width="72"
            height="130"
            class="bus-body"
          />

          <!-- Front windows -->
          <rect x="24" y="26" width="16" height="18" rx="4" class="bus-window" />
          <rect x="42" y="26" width="16" height="18" rx="4" class="bus-window" />
          <rect x="60" y="26" width="16" height="18" rx="4" class="bus-window" />

          <!-- Rear windows -->
          <rect x="24" y="106" width="16" height="18" rx="4" class="bus-window" />
          <rect x="42" y="106" width="16" height="18" rx="4" class="bus-window" />
          <rect x="60" y="106" width="16" height="18" rx="4" class="bus-window" />

          <!-- Mid-body destination/route panel -->
          <rect x="24" y="58" width="52" height="34" rx="8" class="bus-detail" />

        </svg>
      </div>
    `;
  }

  /**
   * Create a Leaflet divIcon for the current zoom level.
   * The icon is intentionally colour- and rotation-agnostic; those are
   * applied per-bus via applyBusStyle() after the marker is in the DOM.
   *
   * @returns {L.DivIcon}
   */
  function createBusIcon() {
    const { width, height } = getBusDimensions();

    return L.divIcon({
      className: "bus-leaflet-icon",
      html: buildBusSvg(width, height),
      iconSize: [width, height],
      iconAnchor: [width / 2, height / 2],
      popupAnchor: [0, -height / 2],
    });
  }

  /**
   * Apply the route colour and current heading to a bus marker's DOM element.
   *
   * This is the only place that writes visual state to the DOM for colour
   * and angle. It is called:
   *   - When a bus is first added to the map.
   *   - When a bus's direction is first computed.
   *   - When the bus hasn't moved (to keep the colour in sync with the map).
   *   - After the colour map is rebuilt (route set changed).
   *   - After setIcon() on zoom (which resets the DOM element).
   *
   * @param {{ marker: L.Marker, routeId: string, angle: number }} bus
   */
  function applyBusStyle(bus) {
    const el = bus.marker.getElement();
    if (!el) return; // marker not yet in the DOM

    // Set the CSS custom property used by .bus-body and the SVG polygon.
    el.style.setProperty("--bus-color", getRouteColor(bus.routeId));

    // Rotate the inner wrapper so the arrow points in the direction of travel.
    const wrap = el.querySelector(".bus-wrap");
    if (wrap) wrap.style.transform = `rotate(${bus.angle ?? 0}deg)`;

    // Show the direction arrow only once the bearing is known.
    const arrow = el.querySelector(".bus-arrow");
    if (arrow) arrow.setAttribute("visibility", bus.hasDirection ? "visible" : "hidden");
  }

  // ─── Geometry helpers ─────────────────────────────────────────────────────

  /** @param {number} d - Degrees. @returns {number} Radians. */
  function toRad(d) {
    return (d * Math.PI) / 180;
  }

  /** @param {number} r - Radians. @returns {number} Degrees. */
  function toDeg(r) {
    return (r * 180) / Math.PI;
  }

  /**
   * Normalise an angle to [0, 360).
   *
   * @param {number} a - Angle in degrees (may be negative or > 360).
   * @returns {number}
   */
  function normalizeAngle(a) {
    let out = a % 360;
    if (out < 0) out += 360;
    return out;
  }

  /**
   * Compute the shortest signed angular delta from angle a to angle b.
   * Result is in (-180, 180] so the bus always rotates the short way around.
   *
   * @param {number} a - Start angle (degrees).
   * @param {number} b - End angle (degrees).
   * @returns {number} Signed delta in degrees.
   */
  function shortestDelta(a, b) {
    let d = normalizeAngle(b) - normalizeAngle(a);
    if (d > 180) d -= 360;
    if (d < -180) d += 360;
    return d;
  }

  /**
   * Compute the compass bearing (0 = north, clockwise) from point 1 to point 2
   * using the spherical law of cosines (accurate enough at city scale).
   *
   * If the two points are virtually identical (GPS jitter), the previous
   * bearing is returned unchanged to avoid spurious rotations.
   *
   * @param {number} lat1 - Origin latitude.
   * @param {number} lon1 - Origin longitude.
   * @param {number} lat2 - Destination latitude.
   * @param {number} lon2 - Destination longitude.
   * @param {number} prev - Previous bearing to return if movement is negligible.
   * @returns {number} Bearing in degrees [0, 360).
   */
  function computeBearing(lat1, lon1, lat2, lon2, prev = 0) {
    const approxMove = Math.abs(lat2 - lat1) + Math.abs(lon2 - lon1);
    if (approxMove < 0.00005) return prev; // ~5 m threshold — treat as stationary

    const phi1 = toRad(lat1);
    const phi2 = toRad(lat2);
    const dLambda = toRad(lon2 - lon1);

    const y = Math.sin(dLambda) * Math.cos(phi2);
    const x =
      Math.cos(phi1) * Math.sin(phi2) -
      Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLambda);

    return normalizeAngle(toDeg(Math.atan2(y, x)));
  }

  // ─── Animation ────────────────────────────────────────────────────────────

  /**
   * Animate a bus rotating from its current angle to newAngle over ROTATE_DURATION ms.
   *
   * Cancels any in-progress rotation for this bus before starting.
   * The rotation is applied directly to the .bus-wrap DOM element's CSS transform
   * to avoid rebuilding the SVG icon on every animation frame.
   *
   * @param {{ marker: L.Marker, angle: number, _cancelRotation: Function|null }} bus
   * @param {number} newAngle - Target heading in degrees [0, 360).
   */
  function animateRotation(bus, newAngle) {
    // Cancel any previous rotation that may still be running.
    if (bus._cancelRotation) bus._cancelRotation();

    let cancelled = false;
    bus._cancelRotation = () => { cancelled = true; };

    const startAngle = bus.angle ?? newAngle;
    const delta = shortestDelta(startAngle, newAngle);
    const start = performance.now();

    function step(now) {
      if (cancelled) return;

      const t = Math.min((now - start) / ROTATE_DURATION, 1);
      const current = normalizeAngle(startAngle + delta * t);

      // Re-query the element each frame in case setIcon() replaced the DOM node.
      const wrap = bus.marker.getElement()?.querySelector(".bus-wrap");
      if (wrap) wrap.style.transform = `rotate(${current}deg)`;

      if (t < 1) requestAnimationFrame(step);
      else { bus.angle = newAngle; bus._cancelRotation = null; }
    }

    requestAnimationFrame(step);
  }

  /**
   * Animate a bus marker sliding from its current visual position to a new GPS position
   * over MOVE_DURATION ms.
   *
   * Cancels any in-progress move for this bus before starting.
   * The start position is taken from the marker's current screen position (not the
   * last reported GPS fix) so that interrupted animations chain smoothly without
   * visible jumps.
   *
   * @param {{ marker: L.Marker, _cancelMove: Function|null }} bus
   * @param {L.LatLng} to - Destination GPS coordinate.
   */
  function animateMove(bus, to) {
    // Cancel any previous move that may still be running.
    if (bus._cancelMove) bus._cancelMove();

    let cancelled = false;
    bus._cancelMove = () => { cancelled = true; };

    // Use the current visual position as start, not the last reported GPS.
    const from = bus.marker.getLatLng();
    const start = performance.now();

    function step(now) {
      if (cancelled) return;

      const t = Math.min((now - start) / MOVE_DURATION, 1);
      bus.marker.setLatLng([
        from.lat + (to.lat - from.lat) * t,
        from.lng + (to.lng - from.lng) * t,
      ]);

      if (t < 1) requestAnimationFrame(step);
      else bus._cancelMove = null;
    }

    requestAnimationFrame(step);
  }

  // ─── Route filter ─────────────────────────────────────────────────────────

  /**
   * Return true if the bus should be visible given the current route filter.
   *
   * @param {{ routeId: string }} bus
   * @returns {boolean}
   */
  function busMatchesFilter(bus) {
    if (selectedRoute === "all") return true;
    return String(bus.routeId) === String(selectedRoute);
  }

  /**
   * Add or remove each bus marker from the map according to the current filter.
   * Called after a route is selected and after each data refresh.
   */
  function applyRouteFilter() {
    for (const bus of Object.values(buses)) {
      const visible = busMatchesFilter(bus);

      if (visible && !map.hasLayer(bus.marker)) {
        bus.marker.addTo(map);
        applyBusStyle(bus); // colour + angle — DOM element is only available after addTo()
      }

      if (!visible && map.hasLayer(bus.marker)) {
        map.removeLayer(bus.marker);
      }
    }
  }

  // ─── Dropdown ─────────────────────────────────────────────────────────────

  /**
   * Rebuild the route <select> options from the current availableRoutes set.
   * Preserves the user's current selection if the route still exists.
   * Resets to "all" if the selected route has disappeared.
   */
  function updateRouteDropdown() {
    const currentValue = routeSelect.value;

    const routes = Array.from(availableRoutes).sort((a, b) =>
      String(a).localeCompare(String(b), undefined, { numeric: true })
    );

    routeSelect.innerHTML = `<option value="all">Select a route</option>`;

    for (const route of routes) {
      const option = document.createElement("option");
      option.value = route;
      option.textContent = route;
      routeSelect.appendChild(option);
    }

    // Restore selection if still valid.
    if (routes.includes(currentValue)) {
      routeSelect.value = currentValue;
    } else {
      routeSelect.value = "all";
      selectedRoute = "all";
    }
  }

  // ─── Popup ────────────────────────────────────────────────────────────────

  /**
   * (Re)bind the click popup for a bus marker with its latest metadata.
   * Called whenever bus data is refreshed so the popup stays up to date.
   *
   * @param {{ marker: L.Marker, routeId: string, vehicleId: string, tripId: string }} bus
   */
  function updateBusPopup(bus) {
    bus.marker.bindPopup(`
      <strong>Route:</strong> ${bus.routeId}<br>
      <strong>Vehicle:</strong> ${bus.vehicleId}<br>
      <strong>Trip:</strong> ${bus.tripId ?? "?"}<br>
    `);
    bus.marker.bindTooltip(`Route ${bus.routeId}`, {
      permanent: false,
      direction: "top",
      offset: [0, -10],
    });
  }

  // ─── Main data refresh ────────────────────────────────────────────────────

  /**
   * Fetch the latest bus snapshot from the API and update all markers.
   *
   * Strategy:
   *  1. Pre-scan the vehicle list to collect route names and rebuild the
   *     colour map *before* processing markers, so applyBusStyle() always
   *     has correct colours on first paint.
   *  2. For each vehicle:
   *     - If new: create marker, add to map, apply style.
   *     - If known and moved: rotate to new bearing, then animate to new position.
   *     - If known and stationary: refresh style (keeps colour in sync).
   *  3. Remove markers for vehicles absent from the latest snapshot.
   *  4. Once at least one bus has a known direction, hide the loading overlay.
   */
  async function updateBuses() {
    try {
      const res = await fetch(API_URL, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const data = await res.json();
      const seen = new Set();   // vehicle IDs present in this snapshot
      const routes = new Set(); // route short names present in this snapshot

      // ── Pass 1: collect routes and rebuild colour map if needed ──────────
      for (const v of data.vehicles || []) {
        if (!v.vehicle_id || v.lat == null || v.lon == null) continue;
        routes.add(String(v.route_id ?? "?").split("_")[1] ?? "?");
      }

      const routesChanged =
        routes.size !== availableRoutes.size ||
        [...routes].some((r) => !availableRoutes.has(r));

      if (routesChanged) {
        availableRoutes = routes;
        updateRouteDropdown();
        legend.update(Array.from(routes).sort((a, b) =>
          String(a).localeCompare(String(b), undefined, { numeric: true })
        ));
        updateLegendVisibility();
        // Re-apply colours to all existing buses — their indices may have shifted.
        for (const bus of Object.values(buses)) applyBusStyle(bus);
      }

      // ── Pass 2: create or update each bus marker ─────────────────────────
      for (const v of data.vehicles || []) {
        if (!v.vehicle_id || v.lat == null || v.lon == null) continue;

        const id = v.vehicle_id;
        const route = String(v.route_id ?? "?").split("_")[1] ?? "?";
        const directionId = Number(v.direction_id ?? 0);
        const pos = L.latLng(v.lat, v.lon);

        seen.add(id);
        routes.add(route);

        if (!buses[id]) {
          // ── New bus: create marker and register state ──────────────────
          const marker = L.marker(pos, { icon: createBusIcon() });

          marker.bindPopup("");

          buses[id] = {
            marker,
            last: pos,          // last reported GPS position
            angle: 0,           // current heading (degrees, 0 = north)
            hasDirection: false, // true once a bearing has been computed
            routeId: route,
            directionId,
            vehicleId: v.vehicle_id,
            tripId: v.trip_id,
          };

          updateBusPopup(buses[id]);

          if (selectedRoute === "all" || selectedRoute === route) {
            marker.addTo(map);
            applyBusStyle(buses[id]); // colour + initial angle (0°)
          }

        } else {
          // ── Known bus: update metadata and animate if position changed ──
          const bus = buses[id];
          const old = bus.last;

          bus.routeId = route;
          bus.directionId = directionId;
          bus.vehicleId = v.vehicle_id;
          bus.tripId = v.trip_id;

          const moved = old.lat !== pos.lat || old.lng !== pos.lng;

          if (moved) {
            const raw = computeBearing(
              old.lat,
              old.lng,
              pos.lat,
              pos.lng,
              bus.angle
            );

            if (!bus.hasDirection) {
              // First movement: snap to bearing immediately, no animation.
              bus.angle = raw;
              bus.hasDirection = true;
              applyBusStyle(bus);
              bus.marker.setLatLng(pos);
              bus.last = pos;
            } else {
              // Subsequent movements: rotate first, then move after rotation ends.
              const stable = raw;

              animateRotation(bus, stable);

              // Delay the move so the bus is already pointing the right way.
              setTimeout(() => {
                animateMove(bus, pos);
              }, ROTATE_DURATION);

              bus.last = pos;
            }
          } else {
            // Bus hasn't moved — refresh style to keep colour in sync.
            applyBusStyle(bus);
          }

          updateBusPopup(bus);
        }
      }

      // ── Pass 3: remove markers for buses no longer in the feed ───────────
      for (const [id, bus] of Object.entries(buses)) {
        if (!seen.has(id)) {
          if (map.hasLayer(bus.marker)) {
            map.removeLayer(bus.marker);
          }
          delete buses[id];
        }
      }

      applyRouteFilter();

      // ── Loading overlay: hide once at least one bus has a known heading ──
      const anyOriented = Object.values(buses).some(b => b.hasDirection);
      if (anyOriented) {
        // Wait one animation frame to ensure the browser has painted the
        // coloured, oriented bus icons before the overlay disappears.
        requestAnimationFrame(() => {
          const overlay = document.getElementById("loading-overlay");
          if (overlay && !overlay.classList.contains("hidden")) {
            overlay.classList.add("hidden");
            overlay.addEventListener("transitionend", () => overlay.remove(), { once: true });
          }
        });
      }

    } catch (e) {
      console.error("Failed to update buses:", e);
    }
  }

  // ─── Zoom handler ─────────────────────────────────────────────────────────

  /**
   * When the map zoom changes bucket, rebuild all bus icons at the new size
   * and re-apply per-bus colour and angle (setIcon() resets the DOM element).
   * A single shared icon object is used for all buses to avoid redundant work.
   */
  map.on("zoomend", () => {
    const bucket = getZoomBucket();
    if (bucket === lastZoomBucket) return; // no size change — nothing to do

    lastZoomBucket = bucket;

    const icon = createBusIcon(); // one icon instance shared by all buses
    for (const bus of Object.values(buses)) {
      if (map.hasLayer(bus.marker)) {
        bus.marker.setIcon(icon);
        applyBusStyle(bus); // restore colour + angle after setIcon() reset
      } else {
        // Bus is filtered out — update its icon so the DOM is correct when re-added.
        bus.marker.setIcon(icon);
      }
    }
  });

  // ─── Bootstrap ────────────────────────────────────────────────────────────

  // Fetch immediately on load, then repeat every REFRESH_MS.
  updateBuses();
  setInterval(updateBuses, REFRESH_MS);
});
