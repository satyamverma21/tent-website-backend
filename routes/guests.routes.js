const express = require('express');
const router = express.Router();
const { checkPhone, createGuest, updateGuestProfile } = require('../controllers/guest.controller');
const { verifyToken } = require('../middleware/auth.middleware');

router.get('/check-phone', checkPhone);
router.post('/create', createGuest);
router.post('/update', verifyToken, updateGuestProfile);

module.exports = router;
