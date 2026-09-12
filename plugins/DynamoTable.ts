import type { CollectedResource, ResourceGenerator } from "../types";

// Shorthand: new aws.DynamoTable('name') or
// new aws.DynamoTable('name', 'partitionKeyName') -- defaults to 'id'.
const generateDynamoTable: ResourceGenerator = (res: CollectedResource) => {
  const [partitionKey] = res.arguments;

  return `
    const ${res.name} = new dynamodb.Table(this, '${res.name}', {
      partitionKey: { name: '${partitionKey ?? "id"}', type: dynamodb.AttributeType.STRING },
    });`;
};

export default generateDynamoTable;
