export type FooInput = {
  // body
  readonly name: string;
  // path param
  readonly param: string;
  // query param
  readonly q?: string;
};

export type FooOutput = {
  timestamp: Date;
};

export type GetFooInput = {
  readonly param: string;
};
