// Example shorthand source. Not real CDK -- `aws.Lambda`/`aws.DynamoTable`
// don't exist as imports here; cloudgear reads this file as data via AST
// parsing, it never executes it.
new aws.Lambda("handler", "./src/handler", "index.handler");
new aws.DynamoTable("items");
new aws.DynamoTable("sessions", "sessionId");
