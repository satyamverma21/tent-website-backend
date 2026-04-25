require("dotenv").config();
const path = require("path");
const fs = require("fs");
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const { runMigrations } = require("./db/migrations");

const app = express();

app.use(cors());
app.use(
  helmet({
    crossOriginResourcePolicy: { policy: "cross-origin" },
  }),
);
app.use(express.json());

const uploadDir = process.env.UPLOAD_DIR || "./uploads";
const resolvedUploadDir = path.resolve(__dirname, uploadDir);
if (!fs.existsSync(resolvedUploadDir)) {
  fs.mkdirSync(resolvedUploadDir, { recursive: true });
  fs.mkdirSync(path.join(resolvedUploadDir, "rooms"), { recursive: true });
  fs.mkdirSync(path.join(resolvedUploadDir, "tents"), { recursive: true });
}
app.use("/uploads", express.static(resolvedUploadDir));

app.use("/api/auth", require("./routes/auth.routes"));
app.use("/api/rooms", require("./routes/rooms.routes"));
app.use("/api/tents", require("./routes/tents.routes"));
app.use("/api/bookings", require("./routes/bookings.routes"));
app.use("/api/guests", require("./routes/guests.routes"));
app.use("/api/payments", require("./routes/payments.routes"));
app.use("/api/receipts", require("./routes/receipts.routes"));
app.use("/api/enquiry", require("./routes/enquiry.routes"));
app.use("/api/admin", require("./routes/admin.routes"));
app.use("/api/promo-codes", require("./routes/promo-code.routes"));

app.use((err, req, res, next) => {
  console.error("Unhandled error middleware:", err);
  if (res.headersSent) {
    return next(err);
  }
  const status = err.status || 500;
  res.status(status).json({ message: err.message || "Internal server error" });
});

const PORT = process.env.PORT || 3000;

runMigrations();

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server listening on port ${PORT}`);
});
