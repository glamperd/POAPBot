async function getRealtimeActiveEvents(db) {
  const now = new Date();

  const res = await db.query(
    "SELECT * FROM events WHERE end_date >= $1::timestamp AND start_date <= $1::timestamp AND is_active = $2",
    [now, true]
  );
  return res;
}

async function getGuildEvents(db, server) {
  const now = new Date();

  const res = await db.any(
    "SELECT * FROM events WHERE end_date >= $1::timestamp AND server = $2::text AND is_active = $3",
    [now, server, true]
  );
  console.log("server", server);
  console.log("res", res);

  return res;
}

async function getGuildActiveEvents(db, server) {
  const now = new Date();

  const res = await db.any(
    "SELECT * FROM events WHERE end_date >= $1::timestamp AND start_date <= $1::timestamp AND server = $2::text AND is_active = $3",
    [now, server, true]
  );

  return res;
}

async function countTotalCodes(db, event_id) {
  const res = await db.one("SELECT count(*) FROM codes WHERE event_id = $1", [
    event_id,
  ]);

  console.log("countTotalCodes", res);

  return res;
}

async function countClaimedCodes(db, event_id) {
  const res = await db.one(
    "SELECT count(*) FROM codes WHERE event_id = $1 AND username IS NOT NULL",
    [event_id]
  );

  console.log("countClaimedCodes", res);

  return res;
}

async function getEventFromPass(db, messageContent) {
  const events = await getRealtimeActiveEvents(db);
  // check for similar strings on active events pass

  const eventSelected = events.find((e) =>
    messageContent.toLowerCase().includes(e.pass.toLowerCase())
  );

  console.log(`[DB] ${eventSelected.length} for pass: ${messageContent}`);

  return eventSelected;
}

async function checkCodeForEventUsername(db, event_id, username) {
  const now = new Date();
  const res = await db
    .task(async (t) => {
      // TODO check whitelisted for event_id
      await t.none(
        "SELECT * FROM codes WHERE event_id = $1 AND username = $2::text",
        [event_id, username]
      );
      const code = await t.one(
        "UPDATE codes SET username = $1, claimed_date = $3::timestamp WHERE code in (SELECT code FROM codes WHERE event_id = $2 AND username IS NULL ORDER BY RANDOM() LIMIT 1) RETURNING code",
        [username, event_id, now]
      );
      console.log(`[DB] checking event: ${event_id}, user: ${username} `);
      return code;
    })
    .then((data) => {
      // console.log(data);
      return data;
    })
    .catch((error) => {
      console.log(`[ERROR] ${error.message} -> ${error.received}`);
      return false;
    });

  return res;
}

module.exports = {
  getRealtimeActiveEvents,
  getEventFromPass,
  checkCodeForEventUsername,
  getGuildEvents,
  countTotalCodes,
  countClaimedCodes,
};
