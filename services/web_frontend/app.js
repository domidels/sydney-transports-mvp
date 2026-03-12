document.addEventListener("DOMContentLoaded", () => {
  const API_URL =
    "https://px97vg8cc5.execute-api.ap-southeast-2.amazonaws.com/buses/latest";

  const REFRESH_MS = 5000;
  const MOVE_DURATION = 4500;
  const ROTATE_DURATION = 300;

  const map = L.map("map", { zoomControl: false }).setView([-33.92, 151.24], 12);

  L.control.zoom({ position: "topright" }).addTo(map);

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: "OpenStreetMap",
  }).addTo(map);

  const routeSelect = document.getElementById("route-select");
  const buses = {};
  let selectedRoute = "all";
  let availableRoutes = new Set();
  let lastZoomBucket = getZoomBucket();

  routeSelect.addEventListener("change", (e) => {
    selectedRoute = e.target.value;
    applyRouteFilter();
  });

  function getZoomBucket() {
    const z = map.getZoom();
    if (z >= 16) return 4;
    if (z >= 15) return 3;
    if (z >= 14) return 2;
    if (z >= 13) return 1;
    return 0;
  }

  function getBusDimensions() {
    switch (getZoomBucket()) {
      case 4:
        return { width: 24, height: 34 };
      case 3:
        return { width: 20, height: 30 };
      case 2:
        return { width: 18, height: 26 };
      case 1:
        return { width: 16, height: 22 };
      default:
        return { width: 14, height: 20 };
    }
  }

  function buildBusSvg(width, height, angle = 0, directionId = 0) {
    const color = directionId === 1 ? "#16a34a" : "#2563eb";

    return `
      <div
        class="bus-wrap"
        style="
          --bus-width:${width}px;
          --bus-height:${height}px;
          --bus-color:${color};
          transform: rotate(${angle}deg);
          transform-origin: center center;
        "
      >
        <svg viewBox="0 -18 100 168" class="bus-svg">
          <polygon
            points="50,-20 32,10 68,10"
            fill="${color}"
            stroke="white"
            stroke-width="3"
            stroke-linejoin="round"
          />

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

          <rect
            x="14"
            y="10"
            rx="16"
            ry="16"
            width="72"
            height="130"
            class="bus-body"
          />

          <rect x="24" y="26" width="16" height="18" rx="4" class="bus-window" />
          <rect x="42" y="26" width="16" height="18" rx="4" class="bus-window" />
          <rect x="60" y="26" width="16" height="18" rx="4" class="bus-window" />

          <rect x="24" y="106" width="16" height="18" rx="4" class="bus-window" />
          <rect x="42" y="106" width="16" height="18" rx="4" class="bus-window" />
          <rect x="60" y="106" width="16" height="18" rx="4" class="bus-window" />

          <rect x="24" y="58" width="52" height="34" rx="8" class="bus-detail" />

          <circle cx="22" cy="36" r="6" class="bus-wheel" />
          <circle cx="78" cy="36" r="6" class="bus-wheel" />
          <circle cx="22" cy="114" r="6" class="bus-wheel" />
          <circle cx="78" cy="114" r="6" class="bus-wheel" />
        </svg>
      </div>
    `;
  }

  function createBusIcon(angle = 0, directionId = 0) {
    const { width, height } = getBusDimensions();

    return L.divIcon({
      className: "bus-leaflet-icon",
      html: buildBusSvg(width, height, angle, directionId),
      iconSize: [width, height],
      iconAnchor: [width / 2, height / 2],
      popupAnchor: [0, -height / 2],
    });
  }

  function toRad(d) {
    return (d * Math.PI) / 180;
  }

  function toDeg(r) {
    return (r * 180) / Math.PI;
  }

  function normalizeAngle(a) {
    let out = a % 360;
    if (out < 0) out += 360;
    return out;
  }

  function shortestDelta(a, b) {
    let d = normalizeAngle(b) - normalizeAngle(a);
    if (d > 180) d -= 360;
    if (d < -180) d += 360;
    return d;
  }

  function computeBearing(lat1, lon1, lat2, lon2, prev = 0) {
    const approxMove = Math.abs(lat2 - lat1) + Math.abs(lon2 - lon1);
    if (approxMove < 0.00005) return prev;

    const phi1 = toRad(lat1);
    const phi2 = toRad(lat2);
    const dLambda = toRad(lon2 - lon1);

    const y = Math.sin(dLambda) * Math.cos(phi2);
    const x =
      Math.cos(phi1) * Math.sin(phi2) -
      Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLambda);

    return normalizeAngle(toDeg(Math.atan2(y, x)));
  }

  function smoothAngle(prev, next, alpha = 0.4) {
    const d = shortestDelta(prev, next);
    return normalizeAngle(prev + d * alpha);
  }

  function animateRotation(bus, newAngle) {
    const startAngle = bus.angle ?? newAngle;
    const delta = shortestDelta(startAngle, newAngle);
    const start = performance.now();

    function step(now) {
      const t = Math.min((now - start) / ROTATE_DURATION, 1);
      const current = normalizeAngle(startAngle + delta * t);

      bus.marker.setIcon(createBusIcon(current, bus.directionId));
      updateBusPopup(bus);

      if (t < 1) {
        requestAnimationFrame(step);
      } else {
        bus.angle = newAngle;
      }
    }

    requestAnimationFrame(step);
  }

  function animateMove(marker, from, to) {
    const start = performance.now();

    function step(now) {
      const t = Math.min((now - start) / MOVE_DURATION, 1);

      const lat = from.lat + (to.lat - from.lat) * t;
      const lon = from.lng + (to.lng - from.lng) * t;

      marker.setLatLng([lat, lon]);

      if (t < 1) requestAnimationFrame(step);
    }

    requestAnimationFrame(step);
  }

  function busMatchesFilter(bus) {
    if (selectedRoute === "all") return true;
    return String(bus.routeId) === String(selectedRoute);
  }

  function applyRouteFilter() {
    for (const bus of Object.values(buses)) {
      const visible = busMatchesFilter(bus);

      if (visible && !map.hasLayer(bus.marker)) {
        bus.marker.addTo(map);
      }

      if (!visible && map.hasLayer(bus.marker)) {
        map.removeLayer(bus.marker);
      }
    }
  }

  function updateRouteDropdown() {
    const currentValue = routeSelect.value;

    const routes = Array.from(availableRoutes).sort((a, b) =>
      String(a).localeCompare(String(b), undefined, { numeric: true })
    );

    routeSelect.innerHTML = `<option value="all">Waverley routes</option>`;

    for (const route of routes) {
      const option = document.createElement("option");
      option.value = route;
      option.textContent = route;
      routeSelect.appendChild(option);
    }

    if (routes.includes(currentValue)) {
      routeSelect.value = currentValue;
    } else {
      routeSelect.value = "all";
      selectedRoute = "all";
    }
  }

  function updateBusPopup(bus) {
    bus.marker.bindPopup(`
      <strong>Route:</strong> ${bus.routeId}<br>
      <strong>Vehicle:</strong> ${bus.vehicleId}<br>
      <strong>Trip:</strong> ${bus.tripId ?? "?"}<br>
      <strong>Direction:</strong> ${bus.directionId}<br>
      <strong>Timestamp:</strong> ${bus.timestamp ?? "?"}
    `);
  }

  async function updateBuses() {
    try {
      const res = await fetch(API_URL, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const data = await res.json();
      const seen = new Set();
      const routes = new Set();

      for (const v of data.vehicles || []) {
        if (!v.vehicle_id || v.lat == null || v.lon == null) continue;

        const id = v.vehicle_id;
        const route = String(v.route_id ?? "?").split("_")[1] ?? "?";
        const directionId = Number(v.direction_id ?? 0);
        const pos = L.latLng(v.lat, v.lon);

        seen.add(id);
        routes.add(route);

        if (!buses[id]) {
          const marker = L.marker(pos, {
            icon: createBusIcon(0, directionId),
          });

          marker.bindPopup("");

          buses[id] = {
            marker,
            last: pos,
            angle: 0,
            hasDirection: false,
            routeId: route,
            directionId,
            vehicleId: v.vehicle_id,
            tripId: v.trip_id,
            timestamp: v.timestamp,
          };

          updateBusPopup(buses[id]);

          if (selectedRoute === "all" || selectedRoute === route) {
            marker.addTo(map);
          }
        } else {
          const bus = buses[id];
          const old = bus.last;

          bus.routeId = route;
          bus.directionId = directionId;
          bus.vehicleId = v.vehicle_id;
          bus.tripId = v.trip_id;
          bus.timestamp = v.timestamp;

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
              bus.angle = raw;
              bus.hasDirection = true;
              bus.marker.setIcon(createBusIcon(raw, bus.directionId));
              bus.marker.setLatLng(pos);
              bus.last = pos;
              updateBusPopup(bus);
            } else {
              const stable = smoothAngle(bus.angle ?? raw, raw);

              animateRotation(bus, stable);

              setTimeout(() => {
                animateMove(bus.marker, old, pos);
              }, ROTATE_DURATION);

              bus.last = pos;
              updateBusPopup(bus);
            }
          } else {
            bus.marker.setIcon(createBusIcon(bus.angle ?? 0, bus.directionId));
            updateBusPopup(bus);
          }
        }
      }

      availableRoutes = routes;
      updateRouteDropdown();

      for (const [id, bus] of Object.entries(buses)) {
        if (!seen.has(id)) {
          if (map.hasLayer(bus.marker)) {
            map.removeLayer(bus.marker);
          }
          delete buses[id];
        }
      }

      applyRouteFilter();
    } catch (e) {
      console.error("Failed to update buses:", e);
    }
  }

  map.on("zoomend", () => {
    const bucket = getZoomBucket();
    if (bucket === lastZoomBucket) return;

    lastZoomBucket = bucket;

    for (const bus of Object.values(buses)) {
      bus.marker.setIcon(createBusIcon(bus.angle ?? 0, bus.directionId));
      updateBusPopup(bus);
    }
  });

  updateBuses();
  setInterval(updateBuses, REFRESH_MS);
});