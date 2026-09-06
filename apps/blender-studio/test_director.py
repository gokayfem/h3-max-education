import copy
import unittest
import tempfile
from pathlib import Path
from director import DEFAULT, validate
from server import Studio


class ContractTests(unittest.TestCase):
    def test_supported_geometry(self):
        scene=copy.deepcopy(DEFAULT);scene.update(floor_fold=35,ceiling_lift=2)
        self.assertEqual(validate({'message':'Fold and lift','scene':scene})['scene']['floor_fold'],35)

    def test_rejects_code_and_unknown_fields(self):
        for field,value in [('python','import os'),('floor_fold',float('nan')),('floor_fold',90),('length',True)]:
            scene=copy.deepcopy(DEFAULT);scene[field]=value
            with self.assertRaises(ValueError):validate({'message':'Invalid','scene':scene})

    def test_requires_complete_scene(self):
        with self.assertRaises(ValueError):validate({'message':'Incomplete','scene':{'floor_fold':10}})

    def test_stale_generation_cannot_replace_visible_video(self):
        with tempfile.TemporaryDirectory() as directory:
            studio=Studio(Path(directory),'test-key','unused')
            studio.state.update(revision=2,video='/media/2/result.mp4')
            studio.update(1,status='ready',video='/media/1/result.mp4')
            self.assertEqual(studio.state['video'],'/media/2/result.mp4')
            studio.update(2,status='ready',message='Current revision')
            self.assertEqual(studio.state['message'],'Current revision')
            studio.pool.shutdown()


if __name__=='__main__':unittest.main()
