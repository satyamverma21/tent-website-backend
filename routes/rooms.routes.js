const express = require('express');
const router = express.Router();
const {
  listRooms,
  searchRooms,
  getRoomById,
  getRoomImages
} = require('../controllers/room.controller');

router.get('/', listRooms);
router.get('/search', searchRooms);
router.get('/:id', getRoomById);
router.get('/:id/images', getRoomImages);

module.exports = router;

