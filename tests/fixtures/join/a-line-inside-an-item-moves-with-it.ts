const values = production
  ? { mode: 'production' }
  : {
      'import.meta.env?.MODE':
        '(import.meta.env ? import.meta.env.MODE : undefined)',
    };
