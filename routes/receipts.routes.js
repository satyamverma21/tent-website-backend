const express = require('express');
const router = express.Router();
const { getReceipt } = require('../controllers/receipt.controller');
const { attachUserIfToken } = require('../middleware/auth.middleware');

router.get('/:bookingId', attachUserIfToken, getReceipt);

module.exports = router;

