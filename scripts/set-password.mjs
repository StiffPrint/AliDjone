import { Store } from "../server/store.mjs";
import { hashPassword } from "../server/auth.mjs";
const login = process.argv[2]?.trim().toLowerCase();
if (!login || !process.env.NEW_PASSWORD || !process.env.DATABASE_PATH)
  throw Error(
    "Set DATABASE_PATH, NEW_PASSWORD and pass the employee email as argument",
  );
const hashed = await hashPassword(process.env.NEW_PASSWORD);
const store = new Store(process.env.DATABASE_PATH);
try {
  store.transaction(() => {
    const user = store.db
      .prepare("SELECT id FROM staff WHERE login=?")
      .get(login);
    if (!user) throw Error("Employee not found");
    store.db
      .prepare("UPDATE staff SET password_hash=? WHERE id=?")
      .run(hashed, user.id);
    store.db.prepare("DELETE FROM sessions WHERE user_id=?").run(user.id);
  });
  console.log("Password changed; all employee sessions revoked.");
} finally {
  store.close();
}
