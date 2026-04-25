const express = require('express');
const router = express.Router();
const { register, login, me, verifyPhone, phoneLogin } = require('../controllers/auth.controller');
const { verifyToken } = require('../middleware/auth.middleware');

router.post('/register', register);
router.post('/login', login);
router.post('/phone-login', phoneLogin);
router.get('/me', verifyToken, me);
router.post('/verify-phone', verifyPhone);

module.exports = router;

