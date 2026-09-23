function f() {
	const columnEntries = Object.entries(fieldsMeta)
		.filter(([, field]) => field && "schema" in field) as Array<[
		string,
		FieldMeta,
	]>;
}
