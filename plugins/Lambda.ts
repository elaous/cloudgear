import type { CollectedResource, ResourceGenerator } from "../types";

// Shorthand: new aws.Lambda('name', './path/to/code', 'index.handler').
// The handler arg is optional (defaults to 'index.handler'); the code path
// is not, since there is no sane default asset directory to fall back to.
const generateLambda: ResourceGenerator = (res: CollectedResource) => {
  const [codePath, handler] = res.arguments;
  if (codePath == null) {
    throw new Error(
      `Lambda "${res.name}": second argument (code asset path) must be a plain string literal, e.g. new aws.Lambda('${res.name}', './src', 'index.handler')`,
    );
  }

  return `
    const ${res.name} = new lambda.Function(this, '${res.name}', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: '${handler ?? "index.handler"}',
      code: lambda.Code.fromAsset('${codePath}'),
    });`;
};

export default generateLambda;
