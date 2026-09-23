export type Middleware = (request: Request, context: RouteContext) =>
	Response |
	null |
	undefined |
	void |
	Promise<Response | null | undefined | void>;
