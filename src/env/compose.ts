// .env files of Docker projects name the database by its Compose service (DB_HOST=pgsql in Laravel Sail),
// which only resolves inside Docker's network. From VS Code the database is the service's published port on
// this machine. This finds it in the project's compose file. No `vscode` and no I/O: callers pass the text.
import { parse } from 'yaml';
import type { DbKind } from '../drivers';
import type { ConnectionConfig } from '../types';

export interface PublishedPort {
  host: string;
  port: number;
  /** For the tooltip, e.g. "docker-compose.yml: pgsql 5432 → localhost:5432". */
  via: string;
}

/**
 * Where `service:containerPort` is published on this machine, or undefined when the compose file doesn't
 * name that service (by service name or container_name) or doesn't publish that port. `vars` fill in
 * `${VAR}`, `${VAR:-default}` and `${VAR-default}` (Docker Compose reads the project's .env the same way).
 */
export function publishedPort(
  composeText: string,
  fileName: string,
  service: string,
  containerPort: number,
  vars: Map<string, string>,
): PublishedPort | undefined {
  const services = servicesOf(composeText);
  if (!services) return undefined;
  const entry =
    Object.prototype.hasOwnProperty.call(services, service) && isObject(services[service])
      ? (services[service] as Record<string, unknown>)
      : Object.values(services).find((s): s is Record<string, unknown> => isObject(s) && s.container_name === service);
  if (!entry || !Array.isArray(entry.ports)) return undefined;

  for (const raw of entry.ports) {
    const mapping = portMapping(raw, vars);
    if (!mapping) continue;
    const { hostIp, published, target } = mapping;
    const offset = containerPort - target.from;
    if (offset < 0 || containerPort > target.to) continue;
    // A range maps one to one; a single published port can't serve a range.
    const port = published.from + offset;
    if (port > published.to) continue;
    const host = !hostIp || hostIp === '0.0.0.0' || hostIp === '::' || hostIp === '[::]' ? 'localhost' : hostIp.replace(/^\[(.*)\]$/, '$1');
    return { host, port, via: `${fileName}: ${service} ${containerPort} → ${host}:${port}` };
  }
  return undefined;
}

/** A database service in a compose file, reachable from this machine through a published port. */
export interface ComposeDatabase {
  service: string;
  config: Omit<ConnectionConfig, 'id'>;
  /** From the service's environment; kept in memory only. */
  password?: string;
  via: string;
  /** The environment variables it was read from, for the tooltip. */
  keys: string[];
}

/**
 * Database services (official postgres / mysql / mariadb images and their variants, from `DbKind.docker`) that
 * publish their port. Credentials come from each service's `environment`, with the image's own defaults;
 * `vars` (the project's .env) fill in `${VAR}`. Services without a published port can't be reached from
 * VS Code and are skipped. Never runs docker: it only reads the file.
 */
export function composeDatabases(composeText: string, fileName: string, vars: Map<string, string>, kinds: DbKind[]): ComposeDatabase[] {
  const services = servicesOf(composeText);
  if (!services) return [];
  const found: ComposeDatabase[] = [];
  for (const [service, entry] of Object.entries(services)) {
    if (!isObject(entry) || typeof entry.image !== 'string') continue;
    const image = imageName(interpolate(entry.image, vars));
    const kind = kinds.find((k) => k.docker?.images.includes(image));
    if (!kind?.docker || !kind.defaultPort) continue;
    const published = publishedPort(composeText, fileName, service, kind.defaultPort, vars);
    if (!published) continue;
    const env = environmentOf(entry.environment, vars);
    const { logins, databaseVars, defaultDatabase } = kind.docker;
    const login =
      logins.find((l) => (l.userVar ? env.has(l.userVar) : env.has(l.passwordVar))) ?? [...logins].reverse().find((l) => l.user);
    const user = (login?.userVar && env.get(login.userVar)) || login?.user || kind.defaultUser || '';
    const databaseVar = databaseVars.find((v) => env.get(v));
    const database = (databaseVar && env.get(databaseVar)) || (defaultDatabase === 'user' ? user : kind.docker.databaseByImage?.[image]);
    found.push({
      service,
      config: {
        // The service name (the tree's description adds type and address).
        name: service,
        type: kind.type,
        host: published.host,
        port: published.port,
        user,
        ...(database ? { database } : {}),
        ssl: kind.docker.ssl ?? 'off',
      },
      password: login ? env.get(login.passwordVar) : undefined,
      via: published.via,
      keys: [login?.userVar, login?.passwordVar, databaseVar].filter((k): k is string => !!k && env.has(k)),
    });
  }
  return found;
}

/** `docker.io/library/postgres:16-alpine` → `postgres`; `pgvector/pgvector:pg16` → `pgvector/pgvector`. */
function imageName(image: string): string {
  let name = image.trim().toLowerCase().replace(/@.*$/, '');
  const slash = name.lastIndexOf('/');
  const colon = name.lastIndexOf(':');
  if (colon > slash) name = name.slice(0, colon);
  const parts = name.split('/');
  // A first part with a dot or port is a registry (docker.io, ghcr.io, localhost:5000).
  if (parts.length > 1 && /[.:]|^localhost$/.test(parts[0])) parts.shift();
  if (parts[0] === 'library') parts.shift();
  return parts.join('/');
}

/** `environment` as a map or a `KEY=value` list, interpolated. */
function environmentOf(raw: unknown, vars: Map<string, string>): Map<string, string> {
  const env = new Map<string, string>();
  if (Array.isArray(raw)) {
    for (const item of raw) {
      const m = /^([^=]+)=(.*)$/s.exec(String(item));
      if (m) env.set(m[1].trim(), interpolate(m[2], vars));
    }
  } else if (isObject(raw)) {
    for (const [k, v] of Object.entries(raw)) if (v !== null && v !== undefined) env.set(k, interpolate(String(v), vars));
  }
  return env;
}

function servicesOf(composeText: string): Record<string, unknown> | undefined {
  let doc: unknown;
  try {
    doc = parse(composeText, { maxAliasCount: 100 });
  } catch {
    return undefined;
  }
  return isObject(doc) && isObject(doc.services) ? doc.services : undefined;
}

interface Range {
  from: number;
  to: number;
}

/** Short ("[ip:]published:target[/proto]") or long ({ target, published, host_ip }) syntax. Unpublished ports are skipped. */
function portMapping(raw: unknown, vars: Map<string, string>): { hostIp?: string; published: Range; target: Range } | undefined {
  if (isObject(raw)) {
    if (raw.protocol !== undefined && String(raw.protocol).toLowerCase() !== 'tcp') return undefined;
    const target = range(interpolate(String(raw.target ?? ''), vars));
    const published = range(interpolate(String(raw.published ?? ''), vars));
    if (!target || !published) return undefined;
    return { hostIp: raw.host_ip === undefined ? undefined : interpolate(String(raw.host_ip), vars), published, target };
  }
  if (typeof raw !== 'string' && typeof raw !== 'number') return undefined;
  const text = interpolate(String(raw), vars).trim();
  const [spec, proto] = text.split('/');
  if (proto && proto.toLowerCase() !== 'tcp') return undefined;
  // IPv6 host IPs are bracketed: [::1]:5432:5432.
  const m = /^(?:(\[[^\]]+\]|[^:]+):)?([^:]+):([^:]+)$/.exec(spec);
  if (!m) return undefined; // "5432" alone: Docker picks a random host port we can't know
  const published = range(m[2]);
  const target = range(m[3]);
  if (!published || !target) return undefined;
  return { hostIp: m[1], published, target };
}

function range(text: string): Range | undefined {
  const m = /^\s*(\d{1,5})(?:\s*-\s*(\d{1,5}))?\s*$/.exec(text);
  if (!m) return undefined;
  const from = Number(m[1]);
  const to = m[2] ? Number(m[2]) : from;
  return from >= 1 && to <= 65535 && from <= to ? { from, to } : undefined;
}

/** Compose variable syntax: ${VAR}, ${VAR:-default}, ${VAR-default}, $VAR; `$$` is a literal `$`. */
function interpolate(text: string, vars: Map<string, string>): string {
  return text.replace(/\$\$|\$\{([A-Za-z_][A-Za-z0-9_]*)(?:(:?)-([^}]*))?\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (match, braced, colon, fallback, bare) => {
    if (match === '$$') return '$';
    const name = braced ?? bare;
    const value = vars.get(name);
    if (fallback !== undefined) return value === undefined || (colon && value === '') ? fallback : value;
    return value ?? '';
  });
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
