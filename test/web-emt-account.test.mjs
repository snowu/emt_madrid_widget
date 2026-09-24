import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { setupEmtAccount } from "../web/emt-account.js";
const { JSDOM } = createRequire(new URL("../api/package.json", import.meta.url))("jsdom");

const ids = ["dialog", "email", "password", "message", "disconnect", "save", "open", "close", "form"];

function setup(response) {
  const { window } = new JSDOM(`<dialog id="account-menu"></dialog>${ids.map((id) =>
    id === "form" ? `<form id="emt-account-form"></form>` : `<button id="emt-account-${id}"></button>`).join("")}`);
  Object.defineProperty(globalThis, "document", { value: window.document, configurable: true });
  const states = [];
  const account = setupEmtAccount({ request: async () => response, onState: (state) => states.push(state) });
  return { account, states };
}

test("connection state is unknown until the worker answers", async () => {
  const { account, states } = setup({ connected: true, required: false });
  account.reset();
  assert.equal(states.at(-1), null);
  await account.load();
  assert.equal(states.at(-1), true);
  account.reset();
  assert.equal(states.at(-1), null);
});

test("an unconnected account is reported once the worker says so", async () => {
  const { account, states } = setup({ connected: false, required: false });
  account.reset();
  await account.load();
  assert.equal(states.at(-1), false);
});
