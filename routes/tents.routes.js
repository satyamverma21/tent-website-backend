const express = require('express');
const router = express.Router();
const {
  listTents,
  searchTents,
  getTentById,
  getTentImages
} = require('../controllers/tent.controller');

router.get('/', listTents);
router.get('/search', searchTents);
router.get('/:id', getTentById);
router.get('/:id/images', getTentImages);

module.exports = router;

