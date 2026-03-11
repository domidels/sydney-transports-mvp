document.addEventListener("DOMContentLoaded", () => {
  const API_URL =
    "https://px97vg8cc5.execute-api.ap-southeast-2.amazonaws.com/buses/latest";

  const REFRESH_MS = 5000;

  const map = L.map("map", {
    zoomControl: false,
  }).setView([-33.92, 151.24], 12);

  L.control.zoom({
    position: "topright",
  }).addTo(map);

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: "OpenStreetMap",
  }).addTo(map);

  const buses = {};
  let lastZoomBucket = getZoomBucket();

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
        return { width: 18, height: 28 };
      case 3:
        return { width: 16, height: 24 };
      case 2:
        return { width: 14, height: 21 };
      case 1:
        return { width: 12, height: 18 };
      default:
        return { width: 10, height: 16 };
    }
  }

  function buildBusSvg(angleDeg, width, height) {
    return `
      <div
        class="bus-wrap"
        style="
          --bus-width:${width}px;
          --bus-height:${height}px;
          transform: rotate(${angleDeg}deg);
        "
      >
        <svg
          class="bus-svg"
          viewBox="0 0 100 150"
          xmlns="http://www.w3.org/2000/svg"
          aria-hidden="true"
        >
          <rect
            class="bus-shadow"
            x="14"
            y="10"
            rx="16"
            ry="16"
            width="72"
            height="130"
            transform="translate(2, 2)"
          />

          <rect
            class="bus-body"
            x="14"
            y="10"
            rx="16"
            ry="16"
            width="72"
            height="130"
          />

          <rect
            class="bus-windshield"
            x="24"
            y="18"
            rx="8"
            ry="8"
            width="52"
            height="28"
          />

          <rect
            class="bus-detail"
            x="24"
            y="50"
            width="52"
            height="4"
            rx="2"
          />

          <rect
            class="bus-window"
            x="24"
            y="62"
            width="16"
            height="20"
            rx="4"
          />
          <rect
            class="bus-window"
            x="42"
            y="62"
            width="16"
            height="20"
            rx="4"
          />
          <rect
            class="bus-window"
            x="60"
            y="62"
            width="16"
            height="20"
            rx="4"
          />

          <rect
            class="bus-door"
            x="30"
            y="92"
            width="40"
            height="28"
            rx="5"
          />
          <line
            class="bus-door-line"
            x1="50"
            y1="92"
            x2="50"
            y2="120"
          />

          <rect
            class="bus-detail"
            x="35"
            y="128"
            width="30"
            height="5"
            rx="2.5"
          />

          <circle class="bus-wheel" cx="22" cy="36" r="6" />
          <circle class="bus-wheel" cx="78" cy="36" r="6" />
          <circle class="bus-wheel" cx="22" cy="114" r="6" />
          <circle class="bus-wheel" cx="78" cy="114" r="6" />
        </svg>
      </div>
    `;
  }

  function createBusIcon(angleDeg = 0) {
    const { width, height } = getBusDimensions();

    return L.divIcon({
      className: "bus-leaflet-icon",
      html: buildBusSvg(angleDeg, width, height),
      iconSize: [width, height],
      iconAnchor: [width / 2, height / 2],
      popupAnchor: [0, -height / 2],
    });
  }

  function refreshBusIconsIfNeeded() {
    const zoomBucket = getZoomBucket();
    if (zoomBucket === lastZoomBucket) return;

    lastZoomBucket = zoomBucket;

    for (const bus of Object.values(buses)) {
      bus.marker.setIcon(createBusIcon(bus.angle ?? 0));
    }
  }

  function computeBearing(fromLat, fromLon, toLat, toLon, previousAngle = 0) {
    const dLat = toLat - fromLat;
    const dLon = toLon - fromLon;

    if (Math.abs(dLat) + Math.abs(dLon) < 1e-7) {
      return previousAngle;
    }

    // 0° = vers le haut du SVG
    return (Math.atan2(dLon, -dLat) * 180) / Math.PI;
  }

  async function updateBuses() {
    try {
      const res = await fetch(API_URL, { cache: "no-store" });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }

      const data = await res.json();
      const seen = new Set();

      for (const v of data.vehicles || []) {
        if (v.lat == null || v.lon == null || !v.vehicle_id) {
          continue;
        }

        const id = v.vehicle_id;
        seen.add(id);

        const newLatLng = L.latLng(v.lat, v.lon);

        if (!buses[id]) {
          const marker = L.marker(newLatLng, {
            icon: createBusIcon(0),
          }).addTo(map);

          marker.bindPopup("");

          buses[id] = {
            marker,
            lastLatLng: newLatLng,
            angle: 0,
          };
        } else {
          const bus = buses[id];
          const oldLatLng = bus.lastLatLng;

          const moved =
            oldLatLng.lat !== newLatLng.lat || oldLatLng.lng !== newLatLng.lng;

          if (moved) {
            const angle = computeBearing(
              oldLatLng.lat,
              oldLatLng.lng,
              newLatLng.lat,
              newLatLng.lng,
              bus.angle
            );

            bus.angle = angle;
            bus.lastLatLng = newLatLng;
            bus.marker.setLatLng(newLatLng);
            bus.marker.setIcon(createBusIcon(angle));
          }
        }

        buses[id].marker.setPopupContent(`
          <strong>Route:</strong> ${v.route_id ?? "?"}<br>
          <strong>Vehicle:</strong> ${v.vehicle_id}<br>
          <strong>Trip:</strong> ${v.trip_id ?? "?"}<br>
          <strong>Timestamp:</strong> ${v.timestamp ?? "?"}
        `);
      }

      for (const [id, bus] of Object.entries(buses)) {
        if (!seen.has(id)) {
          map.removeLayer(bus.marker);
          delete buses[id];
        }
      }
    } catch (err) {
      console.error("Failed to update buses:", err);
    }
  }

  map.on("zoomend", refreshBusIconsIfNeeded);

  updateBuses();
  setInterval(updateBuses, REFRESH_MS);
});