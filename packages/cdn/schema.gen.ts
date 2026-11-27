// Generated from proto/ by scripts/gen-schema.ts; do not edit.

export const CERT_PROVIDERS = ["aws"] as const;

export const CERT_FIELDS = ["provider","name","dns","region","options"] as const;

export const CDN_PROVIDERS = ["aws"] as const;

export const PRICE_CLASSES = ["PriceClass_100","PriceClass_200","PriceClass_All"] as const;

export const METHOD_ROUTINGS = ["function"] as const;

export const CDN_FIELDS = ["provider","name","cert","bucket","router","domain","method_routing","web_acl","web_acl_arn","price_class","options"] as const;
