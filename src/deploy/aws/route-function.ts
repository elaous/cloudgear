import { groupRoutes, routeShape } from "../../routes";

export interface MethodRoute {
  method: string;
  path: string;
  function: string;
}

export const originIdOf = (functionName: string) => `cloudgear-fn-${functionName}`;

const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Mirrors compilePath: {param} is one segment, trailing slash optional.
function pathRegex(shape: string): string {
  return `^${shape.split("{}").map(escapeRegex).join("([^/]+)")}/?$`;
}

// Viewer-request CloudFront Function source selecting the origin by method and path.
export function routeFunctionCode(routes: MethodRoute[]): string {
  const specificity = new Map(groupRoutes(routes.map((r) => ({ ...r }))).map((group, index) => [group.shape, index]));
  const ordered = [...routes].sort((a, b) => (specificity.get(routeShape(a.path)) ?? 0) - (specificity.get(routeShape(b.path)) ?? 0) || a.method.localeCompare(b.method));
  const table = ordered.map((route) => ({ method: route.method, regex: pathRegex(routeShape(route.path)), origin: originIdOf(route.function) }));
  return `import cf from 'cloudfront';

var ROUTES = ${JSON.stringify(table)}.map(function (route) {
  return { method: route.method, regex: new RegExp(route.regex), origin: route.origin };
});

function handler(event) {
  var request = event.request;
  for (var i = 0; i < ROUTES.length; i++) {
    var route = ROUTES[i];
    if (route.method === request.method && route.regex.test(request.uri)) {
      cf.selectRequestOriginById(route.origin);
      return request;
    }
  }
  return {
    statusCode: 404,
    statusDescription: 'Not Found',
    headers: { 'content-type': { value: 'application/json' } },
    body: '{"error":"not found"}'
  };
}
`;
}
