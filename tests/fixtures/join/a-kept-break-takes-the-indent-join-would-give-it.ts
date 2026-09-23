export type GeneratorMiddleware = (request: Request, context: RouteContext) =>
	Generator<Request | undefined, Response | null | undefined | void, Response> |
	AsyncGenerator<
			Request | undefined,
			Response | null | undefined | void,
			Response
	>;
