// Generated from proto/ by scripts/gen-schema.ts; do not edit.

export const ROUTER_PROVIDERS = ["aws","gcp","azure"] as const;

export const AUTHENTICATIONS = ["iam","none"] as const;

export const ROUTER_MODES = ["local","remote"] as const;

export const ROUTE_METHODS = ["GET","POST","PUT","PATCH","DELETE","HEAD","OPTIONS","*"] as const;

export const RESPONSE_KINDS = ["helper","vercel"] as const;

export const SECRET_BINDING_FIELDS = ["store","path","names","renamed","all"] as const;

export const SCHEDULE_RULE_FIELDS = ["cron","query"] as const;

export const FUNCTION_ROUTER_FIELDS = ["provider","name","authenticated","mode","region","secrets","project","optional_env","routes","cert","function_options","network","policies"] as const;

export const FUNCTION_ROUTER_ROUTE_FIELDS = ["method","path","handler","name","public","include","request","response","secrets","schedule","options","on","policies"] as const;
