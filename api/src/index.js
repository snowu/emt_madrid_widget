// Temporary stub so the vitest workers pool can boot before Task 5 lands.
// Replaced by the real router in Task 5.
export default {
  async fetch() {
    return new Response("not found", { status: 404 });
  },
};
