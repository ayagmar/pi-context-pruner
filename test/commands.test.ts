import assert from "node:assert/strict";
import test from "node:test";
import {
  buildHelpText,
  buildStatusText,
  isProfileName,
  isSettableKey,
  parseKeyValue,
  parseSubcommand,
} from "../src/commands.js";
import { EXTENSION_COMMAND } from "../src/constants.js";

void test("parseSubcommand splits name and rest", () => {
  assert.deepEqual(parseSubcommand("balanced now"), {
    name: "balanced",
    rest: "now",
  });
});

void test("parseSubcommand handles empty or single word", () => {
  assert.deepEqual(parseSubcommand(""), { name: "", rest: "" });
  assert.deepEqual(parseSubcommand("status"), { name: "status", rest: "" });
});

void test("parseKeyValue parses key and value", () => {
  assert.deepEqual(parseKeyValue("activate 0.8"), { key: "activate", value: "0.8" });
  assert.deepEqual(parseKeyValue("max-old-chars 3000"), {
    key: "max-old-chars",
    value: "3000",
  });
});

void test("buildHelpText references extension command", () => {
  const help = buildHelpText();
  assert.ok(help.includes(`/${EXTENSION_COMMAND} status`));
  assert.ok(help.includes(`/${EXTENSION_COMMAND} settings`));
  assert.ok(help.includes(`/${EXTENSION_COMMAND} statusbar-on`));
  assert.ok(help.includes(`/${EXTENSION_COMMAND} statusbar-off`));
  assert.ok(help.includes(`/${EXTENSION_COMMAND} set activate`));
  assert.ok(help.includes(`/${EXTENSION_COMMAND} help`));
});

void test("buildStatusText renders enabled/profile", () => {
  assert.equal(
    buildStatusText({ enabled: true, profile: "balanced" }),
    "enabled=yes, profile=balanced"
  );
  assert.equal(
    buildStatusText({ enabled: false, profile: "aggressive" }),
    "enabled=no, profile=aggressive"
  );
});

void test("name validators", () => {
  assert.equal(isProfileName("balanced"), true);
  assert.equal(isProfileName("aggressive"), true);
  assert.equal(isProfileName("other"), false);

  assert.equal(isSettableKey("activate"), true);
  assert.equal(isSettableKey("keep-recent-heavy"), true);
  assert.equal(isSettableKey("unknown"), false);
});
