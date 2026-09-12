// The shorthand DSL this tool parses is intentionally narrow: a resource is
// `new <provider>.<ResourceType>(<name>, ...plainStringArgs)`. Every
// argument after the name must be a plain string literal -- this is not a
// general CDK-call parser, it's a fixed shorthand that gets *compiled into*
// real CDK code by each plugin. Object-literal props, variables, and
// nested expressions in argument position are deliberately unsupported;
// see parseAstForResources()'s validation for what happens when a call
// doesn't fit this shape.
export interface CollectedResource {
  provider: string;
  type: string;
  name: string;
  // null at an index means that positional argument wasn't a plain string
  // literal -- passed through rather than dropped, so a plugin can decide
  // whether that argument was actually required and error accordingly,
  // instead of the parser guessing on the plugin's behalf.
  arguments: (string | null)[];
}

// A plugin turns one resource declaration into the CDK statements that
// belong inside the generated stack's constructor. Throwing is the
// expected way to reject a malformed resource -- there is no fallback
// code path a caller could silently continue on.
export type ResourceGenerator = (res: CollectedResource) => string;
