import { describe, expect, setDefaultTimeout, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Cert } from "@cloudgear/cdn";
import { DNS } from "@cloudgear/dns";
import { AcmCertDriver } from "../packages/cdn/drivers/acm";
import { generate } from "../src/generate";
import { apply } from "../src/deploy/apply";
import { plan } from "../src/deploy/plan";
import { emptyState, fakeAws } from "./helpers";

setDefaultTimeout(30_000);

const entry = path.join(import.meta.dir, "fixtures", "router", "cdn", "cert-only.ts");
const KEY = "@aws.Certificate.example.com";
const issued = (status: string) => () => ({
  Certificate: {
    Status: status,
    DomainValidationOptions: [{ ResourceRecord: { Name: "_v1.example.com.", Type: "CNAME", Value: "_v2.acm-validations.aws." } }],
  },
});

// An app that declares only DNS and a Cert, from source to deployed certificate and back.
describe("deploying an app with a Cert and no CDN", () => {
  test("generate, plan, apply, re-plan and destroy", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cert-deploy-"));
    const { config } = await generate({ entry, configPath: path.join(dir, "c.prototxt"), buildDir: path.join(dir, "b"), project: "app" });
    const state = emptyState();
    const aws = fakeAws({ DescribeCertificateCommand: issued("ISSUED") });

    const created = plan(config, state);
    expect(created.map((a) => [a.key, a.op])).toEqual([["@aws.Lambda.f", "create"], [KEY, "create"]]);
    await apply(created, state, aws.drivers, { save: () => {} });

    expect(aws.of("RequestCertificateCommand")).toEqual([
      expect.objectContaining({ DomainName: "example.com", ValidationMethod: "DNS" }),
    ]);
    expect(aws.names()).not.toContain("CreateDistributionCommand");
    expect(await aws.dns!.get("_v1.example.com", "CNAME")).toMatchObject({ values: ["_v2.acm-validations.aws."] });
    expect(state.entries[KEY]!.outputs.arn).toBe("arn:aws:acm:us-east-1:1:certificate/c1");

    expect(plan(config, state).every((a) => a.op === "noop")).toBe(true);

    const removal = plan({ ...config, certificate: undefined, dns: undefined, function: [] }, state);
    expect(removal.map((a) => [a.key, a.op])).toContainEqual([KEY, "delete"]);
    await apply(removal, state, aws.drivers, { save: () => {} });
    expect(aws.names()).toContain("DeleteCertificateCommand");
    expect(state.entries[KEY]).toBeUndefined();
    expect(await aws.dns!.get("_v1.example.com", "CNAME")).not.toBeNull();
  });

  test("a certificate that fails validation fails the apply and keeps the entry for the next one", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cert-deploy-"));
    const { config } = await generate({ entry, configPath: path.join(dir, "c.prototxt"), buildDir: path.join(dir, "b"), project: "app" });
    const state = emptyState();
    await expect(
      apply(plan(config, state), state, fakeAws({ DescribeCertificateCommand: issued("FAILED") }).drivers, { save: () => {} }),
    ).rejects.toThrow(/FAILED/);
    expect(state.entries[KEY]).toBeDefined();
    const retry = fakeAws({ DescribeCertificateCommand: issued("ISSUED") }, undefined);
    await apply(plan(config, state), state, retry.drivers, { save: () => {} });
    expect(retry.names()).not.toContain("RequestCertificateCommand");
    expect(state.entries[KEY]!.outputs.arn).toBeDefined();
  });

  test("Cert.status() reads the deployed certificate back through the ACM driver", async () => {
    const cert = new Cert("aws", new DNS("aws", "example.com"), {
      driver: new AcmCertDriver({
        send: async () => ({ CertificateSummaryList: [{ DomainName: "example.com", CertificateArn: "arn:aws:acm:us-east-1:1:certificate/c1", Status: "ISSUED", CreatedAt: new Date() }] }),
      } as never),
    });
    expect(await cert.status()).toEqual({ state: "issued", id: "arn:aws:acm:us-east-1:1:certificate/c1" });
  });
});
