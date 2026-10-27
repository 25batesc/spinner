-- Seed for the sample stack's template database. `spinner seed rebuild` loads this file into
-- `sample_seed`; every `spinner up` clones that database for its session.
CREATE TABLE items (
    id integer PRIMARY KEY,
    name text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO items (id, name) VALUES
    (1, 'anvil'),
    (2, 'bucket'),
    (3, 'compass'),
    (4, 'drill'),
    (5, 'easel'),
    (6, 'funnel'),
    (7, 'gasket'),
    (8, 'hammer'),
    (9, 'inkwell'),
    (10, 'jigsaw');
