import importlib.util
import pathlib
import unittest


MIGRATION_PATH = pathlib.Path(__file__).parents[1] / "migrations" / "versions" / "0008_operator_reminder_subject_identity.py"


def load_migration():
  spec = importlib.util.spec_from_file_location("operator_reminder_subject_identity", MIGRATION_PATH)
  module = importlib.util.module_from_spec(spec)
  assert spec.loader is not None
  spec.loader.exec_module(module)
  return module


class FakeOp:
  def __init__(self):
    self.calls = []

  def __getattr__(self, name):
    def capture(*args, **kwargs):
      self.calls.append((name, args, kwargs))
    return capture


class OperatorReminderSubjectIdentityMigrationTest(unittest.TestCase):
  def test_revision_chain_and_expand_upgrade(self):
    migration = load_migration()
    fake = FakeOp()
    migration.op = fake
    migration.upgrade()

    self.assertEqual(migration.revision, "0008_operator_reminder_subject")
    self.assertEqual(migration.down_revision, "0007_operator_reminders")
    added = {call[1][1].name: call[1][1] for call in fake.calls if call[0] == "add_column"}
    self.assertEqual(set(added), {"subject_type", "subject_key", "source_trigger_id"})
    self.assertEqual(added["subject_type"].type.length, 24)
    self.assertFalse(added["subject_type"].nullable)
    self.assertEqual(added["subject_key"].type.length, 512)
    self.assertTrue(added["subject_key"].nullable)
    self.assertEqual(added["source_trigger_id"].type.length, 80)

    alter = next(call for call in fake.calls if call[0] == "alter_column")
    self.assertEqual(alter[1][:2], ("operator_reminders", "circuit_key"))
    self.assertTrue(alter[2]["nullable"])
    sql = "\n".join(str(call[1][0]) for call in fake.calls if call[0] == "execute")
    self.assertIn("subject_key = 'circuit:' || circuit_key", sql)
    self.assertIn("GRANT INSERT ON TABLE public.audit_logs TO oneview_actions", sql)
    checks = {call[1][0]: str(call[1][2]) for call in fake.calls if call[0] == "create_check_constraint"}
    self.assertEqual(set(checks), {"ck_operator_reminders_subject_type", "ck_operator_reminders_subject_shape"})
    self.assertIn("alert_subject", checks["ck_operator_reminders_subject_type"])
    self.assertIn("source_trigger_id is not null", checks["ck_operator_reminders_subject_shape"])
    self.assertIn("subject_key is null or subject_key = 'circuit:' || circuit_key", checks["ck_operator_reminders_subject_shape"])
    self.assertIn("subject_key = 'alert:' || source_host_id || ':' || source_trigger_id", checks["ck_operator_reminders_subject_shape"])

  def test_active_subject_unique_is_partial_and_old_circuit_unique_is_preserved(self):
    migration = load_migration()
    fake = FakeOp()
    migration.op = fake
    migration.upgrade()

    indexes = {call[1][0]: call for call in fake.calls if call[0] == "create_index"}
    active = indexes["uq_operator_reminders_active_data_source_subject"]
    self.assertEqual(active[1][2], ["data_source_id", "subject_type", "subject_key"])
    self.assertTrue(active[2]["unique"])
    self.assertIn("subject_key is not null", str(active[2]["postgresql_where"]))
    self.assertIn("scheduled", str(active[2]["postgresql_where"]))
    self.assertFalse(any(call[0] == "drop_index" for call in fake.calls))

  def test_downgrade_guards_data_before_restoring_not_null(self):
    migration = load_migration()
    fake = FakeOp()
    migration.op = fake
    migration.downgrade()

    first = fake.calls[0]
    self.assertEqual(first[0], "execute")
    guard = str(first[1][0])
    self.assertIn("subject_type = 'alert_subject'", guard)
    self.assertIn("circuit_key is null", guard)
    self.assertIn("cannot downgrade", guard)
    alter_position = next(index for index, call in enumerate(fake.calls) if call[0] == "alter_column")
    drop_column_positions = [index for index, call in enumerate(fake.calls) if call[0] == "drop_column"]
    self.assertLess(0, alter_position)
    self.assertTrue(all(alter_position < index for index in drop_column_positions))
    self.assertFalse(any(call[0] == "execute" and "REVOKE" in str(call[1][0]) for call in fake.calls))


if __name__ == "__main__":
  unittest.main()
