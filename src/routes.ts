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

export interface Behavior {
  pattern: string;
  methods: string[];
  function: string;
}

const PARAM = /\{[A-Za-z_$][\w$]*\}/g;

export function routeShape(path: string): string {
  const shape = path.replace(PARAM, "{}");
  return shape.length > 1 ? shape.replace(/\/$/, "") : shape;
}

export function viewerPattern(shape: string): string {
  return shape.replace(/\{\}/g, "*");
}

export function groupRoutes(routes: EdgeRoute[]): RouteGroup[] {
  const groups = new Map<string, RouteGroup>();
  for (const route of routes) {
    const shape = routeShape(route.path);
    const group = groups.get(shape) ?? { shape, pattern: viewerPattern(shape), methods: [], functions: [] };
    if (!group.methods.includes(route.method)) group.methods.push(route.method);
    if (!group.functions.includes(route.function)) group.functions.push(route.function);
    groups.set(shape, group);
  }
  return [...groups.values()]
    .map((group) => ({ ...group, methods: group.methods.sort(), functions: group.functions.sort() }))
    .sort((a, b) => a.shape.localeCompare(b.shape));
}

// CloudFront tries behaviors in order: literal-heavy first, exact before wildcard.
export function behaviorsFor(routes: EdgeRoute[]): Behavior[] {
  const literal = (pattern: string) => pattern.replace(/\*/g, "").length;
  return groupRoutes(routes)
    .flatMap((group) => {
      const slashed = group.shape.endsWith("{}") || group.shape === "/" ? [] : [`${group.pattern}/`];
      return [group.pattern, ...slashed].map((pattern) => ({ pattern, methods: group.methods, function: group.functions[0]! }));
    })
    .sort((a, b) => literal(b.pattern) - literal(a.pattern) || Number(a.pattern.includes("*")) - Number(b.pattern.includes("*")) || a.pattern.localeCompare(b.pattern));
}

const covers = (general: string, specific: string) => {
  const g = general.split("/");
  const s = specific.split("/");
  return g.length === s.length && general !== specific && g.every((segment, i) => segment === "{}" || segment === s[i]);
};

// Paths CloudFront would send to a function that cannot serve the request: several functions
// on one path, or a literal path hiding methods of the param path that covers it.
export function conflictingGroups(routes: EdgeRoute[]): RouteGroup[] {
  const groups = groupRoutes(routes);
  const conflicts = groups.filter((group) => group.functions.length > 1);
  for (const general of groups) {
    for (const specific of groups) {
      if (!covers(general.shape, specific.shape)) continue;
      const sameFunction = general.functions.length === 1 && specific.functions.length === 1 && general.functions[0] === specific.functions[0];
      if (sameFunction || general.methods.every((method) => specific.methods.includes(method))) continue;
      conflicts.push({
        shape: general.shape,
        pattern: `${general.pattern} and ${specific.pattern}`,
        methods: [...new Set([...general.methods, ...specific.methods])].sort(),
        functions: [...new Set([...general.functions, ...specific.functions])].sort(),
      });
    }
  }
  return conflicts;
}
