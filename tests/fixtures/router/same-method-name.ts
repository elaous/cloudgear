import { FunctionRouter } from "@cloudgear/functions";

export const users = {
  async get() {
    return {};
  },
};

export const orders = {
  async get() {
    return {};
  },
};

new FunctionRouter("aws").url("GET", "/users", users.get, { name: "getUser" }).url("GET", "/orders", orders.get, { name: "getOrder" });
