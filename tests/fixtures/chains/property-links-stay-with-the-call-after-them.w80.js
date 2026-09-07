expect(scratch.firstChild).to.have.property("props").with.all.keys(["oninput"].concat(vnode.props.type ? "type" : [])).and.property("oninput");
