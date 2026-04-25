const express = require('express');
const router = express.Router();
const {
  createPaymentOrder,
  verifyPayment,
  getPaymentByBooking
} = require('../controllers/payment.controller');
const { attachUserIfToken } = require('../middleware/auth.middleware');

router.post('/create-order', attachUserIfToken, createPaymentOrder);
router.post('/verify', attachUserIfToken, verifyPayment);
router.get('/booking/:bookingId', attachUserIfToken, getPaymentByBooking);

module.exports = router;

