const express = require('express');
const router = express.Router();
const {
  createBooking,
  createGuestBooking,
  getGuestBookingById,
  getMyBookings,
  getBookingById,
  cancelBooking
} = require('../controllers/booking.controller');
const { verifyToken } = require('../middleware/auth.middleware');

router.post('/guest', createGuestBooking);
router.get('/guest/:id', getGuestBookingById);
router.post('/', verifyToken, createBooking);
router.get('/my', verifyToken, getMyBookings);
router.get('/:id', verifyToken, getBookingById);
router.put('/:id/cancel', verifyToken, cancelBooking);

module.exports = router;


