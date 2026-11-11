export type FooInput = {
  readonly name: string;
  readonly param: string;
  readonly q?: string;
};

export type FooOutput = {
  timestamp: Date;
};

export type GetFooInput = {
  readonly param: string;
};
