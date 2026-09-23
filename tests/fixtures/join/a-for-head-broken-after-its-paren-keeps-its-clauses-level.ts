for (
	let ancestor = element.parentElement;
	ancestor;
	ancestor = ancestor.parentElement
) {
	visit(ancestor);
}
