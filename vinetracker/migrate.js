/**
 * Migrate the DB to the latest schema version
 * @param {import('node:sqlite').DatabaseSync} db
 */
export function migrate(db) {
  const versionResult = db.prepare('PRAGMA user_version').get();
  let currentVersion = versionResult ? Number(versionResult['user_version']) : 1;
  if (Number.isNaN(currentVersion)) {
    currentVersion = 1;
  }

  const TARGET_VERSION = 2;
  if (currentVersion < TARGET_VERSION) {
    console.log(`Migrating DB from v${currentVersion} to v${TARGET_VERSION}...`);

    if (currentVersion < 2) {
      try {
        // Wrap in a transaction to ensure both happen or neither happens
        db.exec('BEGIN TRANSACTION');

        // 1. Remove the old integer column
        db.exec('ALTER TABLE orders DROP COLUMN cancelled');

        // 2. Add the new TEXT column (defaults to NULL automatically)
        db.exec('ALTER TABLE orders ADD COLUMN cancelledAt TEXT');

        // 3. Update the schema version
        db.exec('PRAGMA user_version = 2');

        db.exec('COMMIT');
        console.log('Schema updated successfully: cancelled -> cancelledAt');
      } catch (err) {
        db.exec('ROLLBACK');
        console.error('Migration failed, changes rolled back:', err);
      }
    }
  }
}
