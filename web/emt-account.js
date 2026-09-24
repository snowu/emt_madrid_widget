/** Connecting your own EMT account, from the account menu.
 *
 * The password is sent once, over HTTPS, to the worker, which logs in with it
 * before saving it encrypted; it is never kept in the browser. Once connected,
 * EMT calls made for you use your own MobilityLabs quota. Without a connection
 * the shared login is used, so connecting is optional. */
export function setupEmtAccount({ request }) {
  const byId = (id) => document.getElementById(`emt-account-${id}`);
  const dialog = byId("dialog");
  const email = byId("email");
  const password = byId("password");
  const message = byId("message");
  const disconnect = byId("disconnect");
  let generation = 0;
  let connected = false;
  let busy = false;

  function update(state) {
    connected = state.connected === true;
    email.value = state.email || "";
    disconnect.hidden = !connected;
    byId("save").textContent = connected ? "Change" : "Connect";
    byId("open").textContent = connected ? "EMT account connected" : "Connect EMT account";
  }
  function pending(value) {
    busy = value;
    byId("save").disabled = value;
    disconnect.disabled = value;
  }

  byId("open").addEventListener("click", () => {
    document.getElementById("account-menu").close();
    message.textContent = connected
      ? "Connected: live times use your own EMT quota. Enter your password again to change it."
      : "Optional. Live times then use your own EMT quota instead of the shared one.";
    dialog.showModal();
  });
  byId("close").addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => { password.value = ""; });

  async function save(method) {
    if (busy) return;
    const current = generation;
    pending(true);
    message.textContent = method === "PUT" ? "Checking with EMT…" : "Disconnecting…";
    const body = method === "PUT" ? JSON.stringify({ email: email.value, password: password.value }) : undefined;
    password.value = "";
    try {
      const result = await request("/auth/emt", { method, body });
      if (current !== generation) return;
      update(result);
      message.textContent = connected
        ? "Connected. Live times and your alerts now use your EMT account."
        : "Disconnected. The shared login is used again.";
    } catch (error) {
      if (current === generation) message.textContent = error.message;
    } finally {
      if (current === generation) pending(false);
    }
  }
  byId("form").addEventListener("submit", (event) => { event.preventDefault(); void save("PUT"); });
  disconnect.addEventListener("click", () => { void save("DELETE"); });

  return {
    /** Signed out, or a different user: forget everything shown. */
    reset() {
      generation += 1;
      pending(false);
      password.value = "";
      message.textContent = "";
      update({ connected: false });
      if (dialog.open) dialog.close();
    },
    /** Reading the state also re-syncs the connection to the user's tracking
     *  runner on the worker. */
    async load() {
      const current = generation;
      try {
        const result = await request("/auth/emt");
        if (current === generation) update(result);
      } catch { /* optional feature: the rest of the page never depends on it */ }
    },
  };
}
