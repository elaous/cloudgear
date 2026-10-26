export interface EdgeRoute {
  method: string;
  path: string;
  function: string;
}

export interface RouteGroup {
  // The path with every {param} written as {}.
  shape: string;
  // CloudFront path pattern: each {param} becomes *.
  pattern: string;
  methods: string[];
  functions: string[];
}

const PARAM = /\{[A-Za-z_$][\w$]*\}/g;

export function routeShape(path: string): string {
  const shape = path.replace(PARAM, "{}");
  return shape.length > 1 ? shape.replace(/\/$/, "") : shape;
}

export function viewerPattern(shape: string): string {
  return shape.replace(/\{\}/g, "*");
}

// CloudFront tries behaviors in order, so literal-heavy patterns go first.
export function groupRoutes(routes: EdgeRoute[]): RouteGroup[] {
  const groups = new Map<string, RouteGroup>();
  for (const route of routes) {
    const shape = routeShape(route.path);
    const group = groups.get(shape) ?? { shape, pattern: viewerPattern(shape), methods: [], functions: [] };
    if (!group.methods.includes(route.method)) group.methods.push(route.method);
    if (!group.functions.includes(route.function)) group.functions.push(route.function);
    groups.set(shape, group);
  }
  const literal = (group: RouteGroup) => group.pattern.replace(/\*/g, "").length;
  return [...groups.values()]
    .map((group) => ({ ...group, methods: group.methods.sort(), functions: group.functions.sort() }))
    .sort((a, b) => literal(b) - literal(a) || a.shape.localeCompare(b.shape));
}

// Paths reaching several functions, which CloudFront cannot tell apart.
export function conflictingGroups(routes: EdgeRoute[]): RouteGroup[] {
  return groupRoutes(routes).filter((group) => group.functions.length > 1);
}
