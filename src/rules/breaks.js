import { format, DEFAULT_MAX_WIDTH } from '../format.js';

/**
 * fold/breaks — decides where the newlines go.
 *
 * The rule is an adapter (§2.4): call the pure format() core, emit each Edit
 * as its own surgical fix (§2.3). All decisions live in format().
 */
export default {
  meta: {
    type: 'layout',
    docs: {
      description: 'Insert and remove line breaks to fit a maximum width.',
    },
    fixable: 'whitespace',
    schema: [
      {
        type: 'object',
        properties: {
          maxWidth: { type: 'integer', minimum: 1 },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      overWidth: 'Line exceeds {{maxWidth}} characters.',
      necessaryBreak: 'Missing line break.',
      inconsistentGroup:
        'This group is partially broken; break every element or none.',
    },
    defaultOptions: [{ maxWidth: DEFAULT_MAX_WIDTH }],
  },

  create(context) {
    const maxWidth = context.options[0]?.maxWidth ?? DEFAULT_MAX_WIDTH;

    return {
      'Program:exit'() {
        for (const edit of format(context.sourceCode, { maxWidth })) {
          context.report({
            loc: edit.loc,
            messageId: edit.messageId,
            data: edit.data,
            fix: (fixer) => fixer.replaceTextRange(edit.range, edit.text),
          });
        }
      },
    };
  },
};
