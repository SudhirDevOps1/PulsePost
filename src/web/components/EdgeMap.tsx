import { useEffect, useMemo, useRef, useState } from 'react';
import { MapContainer, Marker, Popup, TileLayer } from 'react-leaflet';
import { divIcon, latLngBounds, type Map as LeafletMap } from 'leaflet';
import 'leaflet/dist/leaflet.css';

import type { EdgeNode, MonitorStatus } from '../types.ts';
import { formatMs } from './ui.tsx';
import { REGIONS } from './region-colors.ts';

/**
 * Edge map — where health checks actually execute.
 *
 * Every dot is a Cloudflare colo that has run a check, positioned from the
 * built-in coordinate table. This is the panel that justifies running the
 * checker on the edge rather than in one datacenter.
 *
 * Offline behaviour is a first-class path, not an afterthought: if tiles fail
 * to load the map keeps working, markers and all, on a plain background. A
 * self-hosted, privacy-focused tool that silently rendered an empty grey box
 * on a plane would be a bug, not a cosmetic issue.
 */

/**
 * Tile source.
 *
 * Deliberately OpenStreetMap's own standard layer rather than a "dark" style:
 * every hosted dark basemap that is free-and-keyless today (CARTO, Stadia,
 * MapTiler) now demands an API key and renders a watermarked "API KEY REQUIRED"
 * tile when one is absent. OSM needs no key, is already in our CSP, and keeps
 * working for a self-hosted instance with no third-party account at all.
 *
 * The dark appearance comes from a CSS filter on the tile pane (see
 * `styles/tokens.css`), which is the same trick every self-hosted map uses.
 */
const TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

function colorFor(status: MonitorStatus | null): string {
  if (status === 'down') return 'var(--color-down)';
  if (status === 'degraded') return 'var(--color-degraded)';
  if (status === 'up') return 'var(--color-up)';
  return 'var(--color-text-tertiary)';
}

/** Size the dot by latency so a slow-but-healthy colo is still noticeable. */
function sizeFor(node: EdgeNode): number {
  const ms = node.avg_response_time_ms;
  if (ms === null) return 8;
  if (ms < 150) return 9;
  if (ms < 400) return 12;
  return 15;
}

export function EdgeMap({ nodes, height = 340 }: { nodes: EdgeNode[]; height?: number }) {
  const [tilesFailed, setTilesFailed] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const containerRef = useRef<LeafletMap | null>(null);
  const tileFailures = useRef(0);

  const active = useMemo(() => nodes.filter((node) => node.checks_24h > 0), [nodes]);

  // Recentre when the data set changes identity (e.g. after a sweep), but not
  // while the operator has a marker open — yanking the viewport then would be
  // hostile. Leaflet is uncontrolled, so this is an imperative call.
  useEffect(() => {
    if (selected) return;
    const map = containerRef.current;
    if (!map || active.length === 0) return;
    map.fitBounds(latLngBounds(active.map((node) => [node.lat, node.lon] as [number, number])), {
      padding: [24, 24],
    });
  }, [active, selected]);

  if (nodes.length === 0) {
    return (
      <div
        className="clay-inset grid place-items-center px-6 text-center"
        // Reserved height, not required height. Holding the full map height for
        // an empty state reserved 340px of nothing above the fold on every
        // fresh instance -- the first hour of anyone's experience -- while
        // explaining a third of the dashboard's area. The message needs a
        // moment of attention, not a quarter of the screen; the full height
        // comes back the moment there is a map to hold.
        style={{ height: Math.min(height, 168), borderRadius: 'var(--radius-tile)' }}
      >
        <div>
          <p className="text-sm font-medium text-[var(--color-text-primary)]">No edge nodes yet</p>
          <p className="mt-1 max-w-xs text-xs text-[var(--color-text-tertiary)]">
            Nodes appear here after the first scheduled sweep records which Cloudflare colos
            executed your checks.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="relative overflow-hidden rounded-[var(--radius-control)]" style={{ height }}>
      <MapContainer
        ref={containerRef}
        center={[26, 8]}
        zoom={2}
        minZoom={1}
        maxZoom={8}
        scrollWheelZoom
        attributionControl
        className="rounded-[var(--radius-control)]"
        style={{ height, width: '100%' }}
      >
        {!tilesFailed ? (
          <TileLayer
            url={TILE_URL}
            attribution={ATTRIBUTION}
            maxZoom={19}
            eventHandlers={{
              // One failure is not proof the whole layer is dead; give it a
              // couple of tiles before falling back so a flaky cell does not
              // permanently degrade the panel.
              tileerror: () => {
                tileFailures.current += 1;
                if (tileFailures.current >= 3) setTilesFailed(true);
              },
              load: () => {
                tileFailures.current = 0;
              },
            }}
          />
        ) : null}

        {active.map((node) => (
          <Marker
            key={node.colo}
            position={[node.lat, node.lon]}
            icon={edgeIcon(node)}
            eventHandlers={{ click: () => setSelected(node.colo) }}
          >
            <Popup>
              <div className="min-w-[170px] space-y-1">
                <div className="flex items-center gap-2">
                  <span
                    className="inline-block size-2 rounded-full"
                    style={{ background: colorFor(node.status) }}
                  />
                  <strong className="text-sm">{node.city}</strong>
                </div>
                <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
                  <dt className="opacity-60">Colo</dt>
                  <dd className="m-0 font-medium">{node.colo}</dd>
                  <dt className="opacity-60">Country</dt>
                  <dd className="m-0">{node.country}</dd>
                  <dt className="opacity-60">Latency</dt>
                  <dd className="m-0 tabular">{formatMs(node.avg_response_time_ms)}</dd>
                  <dt className="opacity-60">Checks 24h</dt>
                  <dd className="m-0 tabular">{node.checks_24h}</dd>
                </dl>
              </div>
            </Popup>
          </Marker>
        ))}

        {/* With no basemap the markers would sit on black; a faint graticule
            keeps the spatial reading without needing any network request. */}
        {tilesFailed ? <OfflineGraticule /> : null}
      </MapContainer>

      {tilesFailed ? (
        <div className="map-offline-note">
          <span
            className="rounded-[var(--radius-pill)] bg-[var(--color-surface-1)]/92 px-4 py-1.5 text-[11px] font-bold text-[var(--color-text-secondary)]"
            style={{ boxShadow: 'var(--shadow-pill)' }}
          >
            Map tiles unavailable — showing edge positions only
          </span>
        </div>
      ) : null}

      <RegionLegend nodes={active} />
    </div>
  );
}

/**
 * Custom marker.
 *
 * Size encodes latency and a ring animates only for unhealthy nodes, so a
 * glance at the map conveys both "is anything wrong" and "where is it slow".
 */
function edgeIcon(node: EdgeNode) {
  const color = colorFor(node.status);
  const size = sizeFor(node);
  const pulsing = node.status === 'down' || node.status === 'degraded';

  return divIcon({
    className: '',
    html: `
      <span class="edge-marker" style="width:${size}px;height:${size}px">
        ${
          pulsing
            ? `<span class="edge-marker__pulse" style="inset:-2px;background:${color};opacity:0.5"></span>`
            : ''
        }
        <span class="edge-marker__dot" style="width:${size}px;height:${size}px;background:${color}"></span>
      </span>
    `,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
    popupAnchor: [0, -(size / 2 + 4)],
  });
}

/**
 * Lat/long grid drawn as a lightweight SVG overlay.
 * Purely decorative — it keeps the projection legible when tiles are absent.
 */
function OfflineGraticule() {
  const lines: React.ReactNode[] = [];

  for (let lat = -60; lat <= 60; lat += 30) {
    const y = ((90 - lat) / 180) * 100;
    lines.push(
      <line key={`h${lat}`} x1="0" y1={`${y}%`} x2="100" y2={`${y}%`} stroke="var(--color-border-subtle)" strokeWidth="0.4" />,
    );
  }
  for (let lon = -150; lon <= 150; lon += 30) {
    const x = ((lon + 180) / 360) * 100;
    lines.push(
      <line key={`v${lon}`} x1={`${x}%`} y1="0" x2={`${x}%`} y2="100%" stroke="var(--color-border-subtle)" strokeWidth="0.4" />,
    );
  }

  return (
    <svg
      className="pointer-events-none absolute inset-0 z-[400] h-full w-full"
      style={{ pointerEvents: 'none' }}
      aria-hidden="true"
    >
      {lines}
    </svg>
  );
}

function RegionLegend({ nodes }: { nodes: EdgeNode[] }) {
  const counts = REGIONS.map((region) => ({
    region,
    count: nodes.filter((node) => node.region === region).length,
  })).filter((entry) => entry.count > 0);

  if (counts.length === 0) return null;

  return (
    <div className="pointer-events-none absolute left-2.5 top-2.5 z-[500] flex flex-wrap gap-1.5">
      {counts.map((entry) => (
        <span
          key={entry.region}
          className="rounded-[var(--radius-pill)] bg-[var(--color-surface-1)]/92 px-3 py-1 text-[11px] font-bold text-[var(--color-text-secondary)] backdrop-blur"
          style={{ boxShadow: 'var(--shadow-pill)' }}
        >
          {entry.region} · {entry.count}
        </span>
      ))}
    </div>
  );
}

export { TILE_URL };