from glob import glob

from setuptools import find_packages, setup

package_name = 'web_dashboard'

setup(
    name=package_name,
    version='0.1.0',
    packages=find_packages(exclude=['test']),
    data_files=[
        ('share/ament_index/resource_index/packages',
            ['resource/' + package_name]),
        ('share/' + package_name, ['package.xml']),
        # Globbed, NOT listed by hand: a hand-kept list once forgot a file
        # the dashboard needed, and nothing looked broken until the feature
        # silently never appeared. A glob cannot forget.
        # test/test_install_files.py holds the line.
        ('share/' + package_name + '/launch', glob('launch/*.py')),
        ('share/' + package_name + '/config', glob('config/*.yaml')),
    ],
    install_requires=['setuptools'],
    zip_safe=True,
    maintainer='racerbotcar-2',
    maintainer_email='bryanmaubc@gmail.com',
    description="Car-side server for the web-dashboards site, and the foxglove_bridge config.",
    license='MIT',
    tests_require=['pytest'],
    entry_points={
        'console_scripts': [
            'dashboard_node = web_dashboard.dashboard_node:main',
            'remote_check = web_dashboard.remote_check:main',
        ],
    },
)
