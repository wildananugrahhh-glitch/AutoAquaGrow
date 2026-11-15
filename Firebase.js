
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js";

import {
  getDatabase,
  ref,
  onValue
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-database.js";

// Konfigurasi Firebase
const firebaseConfig = {
  apiKey: "AIzaSyC-6TJTmJ9MPJdhssBqERmyiUYbf1DjcBo",
  authDomain: "autoaquagrow-6836f.firebaseapp.com",
  databaseURL: "https://autoaquagrow-6836f-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "autoaquagrow-6836f",
  storageBucket: "autoaquagrow-6836f.firebasestorage.app",
  messagingSenderId: "1097839304705",
  appId: "1:1097839304705:web:8de7a0cb84f15660502000"
};

// Inisialisasi Firebase
const app = initializeApp(firebaseConfig);
const db = getDatabase(app);

// Mengambil data AutoAquaGrow
const dataRef = ref(db, "AutoAquaGrow");

// Mendengarkan perubahan secara realtime
onValue(dataRef, (snapshot) => {

  const data = snapshot.val();

  if (!data) {
    console.log("Belum ada data dari ESP32");
    return;
  }

  const sensor = data.sensor || {};
  const pompa = data.pompa || {};

  // Tampilkan kelembapan
  document.getElementById("moisture-value").textContent =
    (sensor.kelembapan ?? "--") + "%";

  // Tampilkan ADC
  document.getElementById("adc-value").textContent =
    sensor.adc ?? "--";

  // Tampilkan kondisi tanah
  document.getElementById("soil-status").textContent =
    sensor.status ?? "Menunggu data";

  // Tampilkan status pompa
  document.getElementById("pump-status").textContent =
    pompa.status ?? "--";

  console.log("Data Firebase diperbarui:", data);

}, (error) => {

  console.error("Gagal membaca Firebase:", error);

});
