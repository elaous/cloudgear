export type PolicyProvider = "aws";

export interface PolicyDocument {
  Version: string;
  Id?: string;
  Statement: Record<string, unknown> | Record<string, unknown>[];
}

export interface PolicyOptions {
  // Name of the inline policy on the function's role. Literal only; MUST NOT start with "cloudgear".
  name: string;
  // The policy itself: an object literal, or `import document from "./policies/x.json"`. Literal only.
  document: PolicyDocument;
}

// IAM caps the inline policies of a role at 10,240 characters in all; one policy is held to that too.
export const MAX_POLICY_CHARS = 10_240;

const NAME = /^[\w+=,.@-]{1,128}$/;

export function assertPolicyName(name: string): string {
  if (!NAME.test(name)) throw new Error(`Invalid policy name "${name}": 1 to 128 letters, digits and + = , . @ _ -`);
  if (name.toLowerCase().startsWith("cloudgear")) throw new Error(`Policy name "${name}" is reserved: names starting with "cloudgear" belong to the policies cloudgear writes`);
  return name;
}

export function assertPolicyDocument(document: unknown, name = "policy"): asserts document is PolicyDocument {
  const doc = document as Partial<PolicyDocument> | null;
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) throw new Error(`The document of ${name} must be an object`);
  if (doc.Version !== "2012-10-17" && doc.Version !== "2008-10-17") throw new Error(`The document of ${name} needs Version "2012-10-17"`);
  const statements = Array.isArray(doc.Statement) ? doc.Statement : doc.Statement ? [doc.Statement] : [];
  if (!statements.length) throw new Error(`The document of ${name} needs at least one Statement`);
  for (const [index, statement] of statements.entries()) {
    const s = statement as Record<string, unknown>;
    if (typeof s !== "object" || s === null) throw new Error(`Statement ${index} of ${name} must be an object`);
    if (s.Effect !== "Allow" && s.Effect !== "Deny") throw new Error(`Statement ${index} of ${name} needs Effect "Allow" or "Deny"`);
    if (!s.Action && !s.NotAction) throw new Error(`Statement ${index} of ${name} needs an Action`);
    if (!s.Resource && !s.NotResource) throw new Error(`Statement ${index} of ${name} needs a Resource`);
  }
  if (JSON.stringify(document).length > MAX_POLICY_CHARS) throw new Error(`The document of ${name} is over IAM's ${MAX_POLICY_CHARS} characters`);
}

// What a reader of a `plan` should look at twice: Allow statements that name every action or every resource.
export function broadStatements(document: PolicyDocument): string[] {
  const statements = Array.isArray(document.Statement) ? document.Statement : [document.Statement];
  const found: string[] = [];
  for (const [index, statement] of statements.entries()) {
    const s = statement as Record<string, unknown>;
    if (s.Effect !== "Allow") continue;
    const many = (value: unknown) => (Array.isArray(value) ? value : [value]);
    if (many(s.Action).includes("*")) found.push(`statement ${index} allows every action ("Action": "*")`);
    if (many(s.Resource).includes("*")) found.push(`statement ${index} applies to every resource ("Resource": "*")`);
  }
  return found;
}

// An inline IAM policy for a function's role. Constructing it does nothing; `cloudgear apply` puts it on the role.
export class Policy {
  constructor(
    readonly provider: PolicyProvider,
    readonly options: PolicyOptions,
  ) {
    if (provider !== "aws") throw new Error(`Policy provider "${provider}" is not supported yet (supported: aws)`);
    assertPolicyName(options.name);
    assertPolicyDocument(options.document, options.name);
  }

  get name(): string {
    return this.options.name;
  }

  get document(): PolicyDocument {
    return this.options.document;
  }
}
