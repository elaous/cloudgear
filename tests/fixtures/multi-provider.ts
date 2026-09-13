new aws.Lambda("handler", "./src/handler", "index.handler");
new gcp.PubSubTopic("events");
