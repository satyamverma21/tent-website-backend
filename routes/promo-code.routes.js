const express = require('express');
const router = express.Router();
const promoCodeController = require('../controllers/promo-code.controller');
const { verifyToken, requireAdmin } = require('../middleware/auth.middleware');

// Get all promo codes (admin only)
router.get('/', verifyToken, requireAdmin, promoCodeController.getAllPromoCodes);

// Get promo code by ID (admin only)
router.get('/:id', verifyToken, requireAdmin, promoCodeController.getPromoCodeById);

// Create new promo code (admin only)
router.post('/', verifyToken, requireAdmin, promoCodeController.createPromoCode);

// Update promo code (admin only)
router.put('/:id', verifyToken, requireAdmin, promoCodeController.updatePromoCode);

// Delete promo code (admin only)
router.delete('/:id', verifyToken, requireAdmin, promoCodeController.deletePromoCode);

// Get all agents (admin only)
router.get('/agents/list', verifyToken, requireAdmin, promoCodeController.getAgents);

// Get agent referrals (admin only)
router.get('/agents/:agent_id/referrals', verifyToken, requireAdmin, promoCodeController.getAgentReferrals);

// Validate promo code (public)
router.post('/validate', promoCodeController.validatePromoCode);

module.exports = router;
